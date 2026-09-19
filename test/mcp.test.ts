import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { join } from "node:path";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";

test("real stdio MCP handshake, execution, backread and schema rejection", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "test/fixtures/server.ts")],
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (buffer) => {
    diagnostics += buffer.toString();
  });
  const client = new Client({ name: "sift-contract-test", version: "1" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((x) => x.name).sort(), [
      "execute",
      "read_result",
    ]);
    const request = {
      executable: process.execPath,
      args: ["-e", 'process.stdout.write("KEEP original evidence")'],
      cwd: process.cwd(),
      purpose: "Find evidence",
    };
    const result = await client.callTool({
      name: "execute",
      arguments: request,
    });
    assert.equal(result.isError, false);
    const content = result.content as Array<{ text: string }>;
    const parsed = JSON.parse(content[0]!.text);
    assert.equal(parsed.evidence[0].text, "KEEP original evidence");
    const read = await client.callTool({
      name: "read_result",
      arguments: {
        result_id: parsed.result_id,
        stream: "stdout",
        offset: 0,
        limit: 100,
      },
    });
    assert.equal(
      JSON.parse((read.content as Array<{ text: string }>)[0]!.text).data,
      "KEEP original evidence",
    );
    const invalid = await client.callTool({
      name: "execute",
      arguments: { ...request, threshold: 0 },
    });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
  }
  assert.equal(diagnostics, "");
});

test("production CLI starts, handles empty output without network, and releases its store on EOF", async () => {
  const root = await mkdtemp(join(tmpdir(), "sift-cli-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "src/cli.ts")],
    env: {
      PATH: process.env.PATH!,
      SIFT_STATE_DIR: root,
      SIFT_THRESHOLD: "0.8",
      TYPESAFE_API_KEY: "test-only-no-network",
    },
    stderr: "pipe",
  });
  let diagnostics = "";
  transport.stderr?.on("data", (buffer) => {
    diagnostics += buffer.toString();
  });
  const client = new Client({ name: "cli-contract-test", version: "1" });
  try {
    await client.connect(transport);
    const result = await client.callTool({
      name: "execute",
      arguments: {
        executable: process.execPath,
        args: ["-e", ""],
        cwd: process.cwd(),
        purpose: "Check empty command output",
      },
    });
    assert.equal(result.isError, false);
    const parsed = JSON.parse(
      (result.content as Array<{ text: string }>)[0]!.text,
    );
    assert.equal(parsed.judgment.requests, 0);
    assert.deepEqual(parsed.evidence, []);
  } finally {
    await client.close();
  }
  await assert.rejects(access(join(root, ".lock")), { code: "ENOENT" });
  await rm(root, { recursive: true });
  assert.equal(diagnostics, "");
});
