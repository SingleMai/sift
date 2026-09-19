import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

const live = process.argv.includes("--live");
if (live && !process.env.TYPESAFE_API_KEY)
  throw new Error("Live installed-package check requires TYPESAFE_API_KEY");
const metadata = JSON.parse(await readFile("package.json", "utf8"));
const destination = resolve(".tmp/release");
await mkdir(destination, { recursive: true });
const pack = z
  .array(
    z.object({
      filename: z.string(),
      files: z.array(z.object({ path: z.string() })),
    }),
  )
  .parse(
    JSON.parse(
      execFileSync(
        "npm",
        [
          "pack",
          "--ignore-scripts",
          "--json",
          "--pack-destination",
          destination,
        ],
        { encoding: "utf8" },
      ),
    ),
  )[0]!;
assert.ok(pack.files.some((file) => file.path === "dist/cli.js"));
assert.ok(pack.files.some((file) => file.path === "npm-shrinkwrap.json"));
assert.ok(
  pack.files.every((file) =>
    /^(dist\/|docs\/(configuration|preview)\.md$|package\.json$|npm-shrinkwrap\.json$|README\.md$)/.test(
      file.path,
    ),
  ),
  "Unexpected private/development file in package",
);
const artifact = join(destination, pack.filename);
const hash = createHash("sha256")
  .update(await readFile(artifact))
  .digest("hex");
await writeFile(join(destination, "SHA256SUMS"), `${hash}  ${pack.filename}\n`);
const root = await mkdtemp(join(tmpdir(), "sift-installed-"));
let report: unknown;
try {
  // Runtime installation must not depend on repository source, build tools or lifecycle scripts.
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      root,
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      artifact,
    ],
    { encoding: "utf8", stdio: "pipe" },
  );
  const bin = join(root, "node_modules", ".bin", "sift");
  const env = {
    PATH: process.env.PATH!,
    SIFT_STATE_DIR: join(root, "state"),
    SIFT_THRESHOLD: "0.8",
    TYPESAFE_API_KEY: live
      ? process.env.TYPESAFE_API_KEY!
      : "offline-no-network",
  };
  assert.equal(
    execFileSync(bin, ["--version"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH! },
    }).trim(),
    metadata.version,
  );
  assert.ok(
    execFileSync(bin, ["--help"], {
      encoding: "utf8",
      env: { PATH: process.env.PATH! },
    }).includes("stdio MCP"),
  );
  await assert.rejects(access(join(root, "node_modules", "tsx")), {
    code: "ENOENT",
  });
  const client = new Client({ name: "sift-package-validation", version: "1" });
  const transport = new StdioClientTransport({
    command: bin,
    args: [],
    env,
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (b) => {
    diagnostics += b.toString();
  });
  const text = live
    ? "The package integration check executed one public synthetic command. Result: success.\n"
    : "";
  try {
    await client.connect(transport);
    assert.equal(client.getServerVersion()?.version, metadata.version);
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
      ["execute", "read_result"],
    );
    const result = await client.callTool({
      name: "execute",
      arguments: {
        executable: process.execPath,
        args: ["-e", `process.stdout.write(${JSON.stringify(text)})`],
        cwd: root,
        purpose: "Report the outcome of the package integration check.",
      },
    });
    assert.equal(result.isError, false);
    const value = JSON.parse(
      z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .parse(result.content)[0]!.text,
    );
    await writeFile(
      join(
        destination,
        live
          ? "verification-live-attempt.json"
          : "verification-offline-attempt.json",
      ),
      JSON.stringify(
        {
          version: metadata.version,
          execution: value.execution,
          judgment: value.judgment,
        },
        null,
        2,
      ) + "\n",
    );
    if (!value.judgment.complete)
      throw new Error(
        `Installed package judgment incomplete: ${JSON.stringify(value.judgment)}`,
      );
    assert.equal(value.execution.exitCode, 0);
    assert.equal(value.judgment.complete, true);
    assert.equal(value.judgment.requests, live ? 1 : 0);
    assert.equal(
      value.evidence.map((item: { text: string }) => item.text).join(""),
      text,
    );
    const read = await client.callTool({
      name: "read_result",
      arguments: {
        result_id: value.result_id,
        stream: "stdout",
        offset: 0,
        limit: 4096,
      },
    });
    assert.equal(read.isError, false);
    assert.equal(
      JSON.parse(
        z
          .array(z.object({ type: z.literal("text"), text: z.string() }))
          .parse(read.content)[0]!.text,
      ).data,
      text,
    );
    report = {
      version: metadata.version,
      artifact: pack.filename,
      sha256: hash,
      files: pack.files.length,
      live,
      serverVersion: client.getServerVersion(),
      judgment: value.judgment,
      exactBackread: true,
    };
  } finally {
    await client.close();
  }
  assert.equal(diagnostics, "");
  await assert.rejects(access(join(root, "state", ".lock")), {
    code: "ENOENT",
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
await writeFile(
  join(
    destination,
    live ? "verification-live.json" : "verification-offline.json",
  ),
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
