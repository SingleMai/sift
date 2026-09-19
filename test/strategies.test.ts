import test from "node:test";
import { setup, run } from "./helpers.js";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  tapStrategy,
  searchStrategy,
  commandStrategy,
} from "../src/strategies.js";
import { windowStrategy } from "../src/chunks.js";

async function indexed(
  text: string,
  strategy: typeof tapStrategy,
  limit = 8192,
) {
  const root = await mkdtemp(join(tmpdir(), "sift-record-test-"));
  try {
    const bytes = Buffer.from(text),
      path = join(root, "raw");
    await writeFile(path, bytes);
    const spans = await strategy.index(path, "stdout", limit);
    let end = 0;
    for (const span of spans) {
      assert.equal(span.start, end);
      assert.ok(span.end - span.start <= Math.min(limit, 1024));
      for (const [offset, position] of [
        [span.start, span.from],
        [span.end, span.to],
      ] as const) {
        const prefix = bytes.subarray(0, offset);
        assert.equal(
          position.line,
          prefix.filter((byte) => byte === 10).length + 1,
        );
        assert.equal(
          position.byteColumn,
          prefix.length - prefix.lastIndexOf(10),
        );
      }
      end = span.end;
    }
    assert.equal(end, bytes.length);
    const parts = spans.map((span) =>
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes.subarray(span.start, span.end),
      ),
    );
    assert.equal(parts.join(""), text);
    return parts;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("TAP keeps fitting failure diagnostics together and separates aggregate summary", async () => {
  const healthy = Array.from(
    { length: 20 },
    (_, i) =>
      `# Subtest: healthy ${i}\nok ${i + 1} - healthy ${i}\n  ---\n  duration_ms: 1\n  ...\n`,
  ).join("");
  const failure =
    "# Subtest: failed\nnot ok 21 - failed\n  ---\n  expected: paid\n  actual: pending\n  ...\n";
  const summary = "1..21\n# tests 21\n# pass 20\n# fail 1\n";
  const parts = await indexed(
    "TAP version 13\n" + healthy + failure + summary,
    tapStrategy,
  );
  assert.ok(parts.some((part) => part.includes(failure)));
  assert.equal(parts.at(-1), summary);
  assert.ok(
    parts.length < 10,
    "pack adjacent test records instead of one provider call per test",
  );
});

test("record strategies preserve CRLF, Unicode, long lines, nested TAP and incomplete records", async () => {
  for (const strategy of [tapStrategy, searchStrategy])
    for (const text of [
      "",
      "\ufeff中文🙂\r\nlast",
      "# Subtest: outer\n    # Subtest: nested\n    not ok 1 - inner\nnot ok 1 - outer\n1..1\n# fail 1\n",
      "# Subtest: truncated\n  diagnostic: " + "🙂".repeat(2000),
      "a".repeat(900) + "\r\n" + "b".repeat(900) + "\n",
    ])
      await indexed(text, strategy, 256);
});

test("search groups fit complete result lines when possible and bound request amplification", async () => {
  const lines = Array.from(
    { length: 100 },
    (_, i) => `file.ts:${i + 1}: value${i} = true\n`,
  );
  const parts = await indexed(lines.join(""), searchStrategy);
  assert.ok(parts.length < 10);
  for (const line of lines)
    assert.ok(parts.some((part) => part.includes(line)));
});

test("resolver recognizes only explicit direct command formats and leaves stderr generic", () => {
  const command = {
    executable: "/usr/bin/node",
    args: ["--test", "--test-reporter=tap", "test.mjs"],
    cwd: "/tmp",
    purpose: "test",
  };
  assert.equal(commandStrategy(command, "stdout"), tapStrategy);
  assert.equal(commandStrategy(command, "stderr"), windowStrategy);
  assert.equal(
    commandStrategy(
      { ...command, executable: "rg", args: ["--line-number", "retry", "src"] },
      "stdout",
    ),
    searchStrategy,
  );
  for (const changed of [
    { executable: "sh", args: ["-c", "node --test --test-reporter=tap"] },
    {
      executable: "node",
      args: ["--test", "--test-reporter=tap", "--test-reporter=spec"],
    },
    { executable: "rg", args: ["--line-number", "--json", "retry"] },
    { executable: "rg", args: ["--line-number", "-0n", "retry"] },
  ])
    assert.equal(
      commandStrategy({ ...command, ...changed }, "stdout"),
      windowStrategy,
    );
});

test("command strategy selection is observable and call budgets leave raw evidence recoverable", async () => {
  const env = await setup({ chunkStrategy: "command", maxJudgments: 2 });
  // A nested Node runner must not inherit the parent's private binary reporter mode.
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    const result = await run(
      env.service.execute({
        executable: process.execPath,
        args: ["--test", "--test-reporter=tap", "eval/tasks/failure.mjs"],
        cwd: process.cwd(),
        purpose: "Find failed tests and failure count",
      }),
    );
    assert.equal(result.execution?.exitCode, 1);
    assert.equal(result.judgment.strategies.stdout, "node-tap-records-v1");
    assert.equal(result.judgment.requests, 2);
    assert.equal(result.judgment.complete, false);
    assert.ok(result.judgment.counts.unprocessed > 0);
    assert.ok(
      result.judgment.issues.some(
        (issue) => issue.reason === "unprocessed:budget",
      ),
    );
    const original = await run(
      env.service.read({
        result_id: result.result_id,
        stream: "stdout",
        offset: 0,
        limit: 24576,
      }),
    );
    assert.ok(original.data.includes("# fail 1"));
  } finally {
    if (parentTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = parentTestContext;
    await env.close();
  }
});
