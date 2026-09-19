import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  access,
  readdir,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaults } from "../src/config.js";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error(
    "TYPESAFE_API_KEY is required for this opt-in billable MCP check.",
  );
const root = await mkdtemp(join(tmpdir(), "sift-live-mcp-"));
const repositoryTest = process.argv.includes("--repository-test");
const config = join(root, "config.json"),
  stateDir = join(root, "artifacts");
await writeFile(
  config,
  JSON.stringify({
    threshold: 0.8,
    model: defaults.model,
    stateDir,
    chunkBytes: repositoryTest ? 1024 : 256,
    outputBytes: 65536,
  }),
  { mode: 0o600 },
);
const client = new Client({ name: "sift-live-validation", version: "1" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(process.cwd(), "dist/cli.js")],
  env: {
    PATH: process.env.PATH!,
    SIFT_CONFIG: config,
    TYPESAFE_API_KEY: process.env.TYPESAFE_API_KEY,
  },
  stderr: "pipe",
});
let diagnostics = "";
transport.stderr?.on("data", (b) => {
  diagnostics += b.toString();
});
const noise =
  "For test-runner documentation, visit the project help page.".padEnd(
    255,
    " ",
  ) + "\n";
const evidence =
  "No test files found. Exiting with code 0 because passWithNoTests is enabled.".padEnd(
    255,
    " ",
  ) + "\n";
let report: unknown;
try {
  await client.connect(transport);
  const start = performance.now();
  const files = repositoryTest
    ? (await readdir("test"))
        .filter((file) => file.endsWith(".test.ts"))
        .sort()
        .map((file) => join("test", file))
    : [];
  const result = await client.callTool({
    name: "execute",
    arguments: {
      executable: process.execPath,
      args: repositoryTest
        ? ["--import", "tsx", "--test", "--test-reporter=tap", ...files]
        : ["-e", `process.stdout.write(${JSON.stringify(noise + evidence)})`],
      cwd: process.cwd(),
      purpose: repositoryTest
        ? "Determine whether actual test cases executed, how many passed or failed, and report any failures."
        : "Determine whether actual test cases executed.",
    },
  });
  const durationMs = performance.now() - start;
  assert.equal(result.isError, false);
  const value = JSON.parse(
    (result.content as Array<{ text: string }>)[0]!.text,
  );
  const manifest = JSON.parse(
    await readFile(join(stateDir, value.result_id, "manifest.json"), "utf8"),
  );
  const read = await client.callTool({
    name: "read_result",
    arguments: {
      result_id: value.result_id,
      stream: "stdout",
      offset: 0,
      limit: 24576,
    },
  });
  const original = JSON.parse(
    (read.content as Array<{ text: string }>)[0]!.text,
  );
  assert.equal(
    original.data,
    await readFile(join(stateDir, value.result_id, "stdout"), "utf8"),
  );
  if (!repositoryTest) assert.equal(original.data, noise + evidence);
  const selected = value.evidence
    .map((span: { text: string }) => span.text)
    .join("");
  report = {
    recordedAt: new Date().toISOString(),
    model: defaults.model,
    threshold: 0.8,
    durationMs,
    execution: value.execution,
    judgment: value.judgment,
    probabilities: manifest.records.map(
      (record: { start: number; end: number; decision: unknown }) => ({
        start: record.start,
        end: record.end,
        decision: record.decision,
      }),
    ),
    exactBackread: true,
    executeResultJsonBytes: Buffer.byteLength(
      (result.content as Array<{ text: string }>)[0]!.text,
    ),
    verificationReadJsonBytes: Buffer.byteLength(
      (read.content as Array<{ text: string }>)[0]!.text,
    ),
    ...(repositoryTest
      ? {
          expectedEvidenceKept:
            /# tests \d+/.test(selected) &&
            /# pass \d+/.test(selected) &&
            /# fail 0/.test(selected),
          summary: selected.match(/# (?:tests|pass|fail) \d+/g),
        }
      : {
          expectedEvidenceKept: selected.includes("No test files found"),
          expectedNoiseOmitted: !selected.includes("project help page"),
        }),
    capturedBytes: Buffer.byteLength(original.data),
    selectedBytes: Buffer.byteLength(selected),
    limitations: repositoryTest
      ? "One real public-repository passing-test output; no failing-test task or broader calibration."
      : "One synthetic two-window MCP run, not task-quality calibration.",
  };
} finally {
  await client.close();
}
await assert.rejects(access(join(stateDir, ".lock")), { code: "ENOENT" });
assert.equal(diagnostics, "");
await rm(root, { recursive: true });
await mkdir(".tmp", { recursive: true });
await writeFile(
  repositoryTest ? ".tmp/live-mcp-repository.json" : ".tmp/live-mcp.json",
  JSON.stringify(report, null, 2),
);
console.log(JSON.stringify(report));
