import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fake, nodeCommand, run, setup } from "./helpers.js";
import { SiftService } from "../src/service.js";
import { failure } from "../src/errors.js";

import { spawnSync } from "node:child_process";

test("filters below threshold, preserves failed exit and raw backread across restart", async () => {
  const env = await setup(
    { chunkBytes: 256, outputBytes: 65536 },
    fake(async ({ target }) => ({
      probability: target.includes("KEEP") ? 0.9 : 0.1,
      inputTokens: 2,
      outputTokens: 1,
    })),
  );
  try {
    const content =
      "DROP".padEnd(255, ".") + "\n" + "KEEP No test files found\n";
    const result = await run(
      env.service.execute(
        nodeCommand(
          `process.stdout.write(${JSON.stringify(content)});process.exitCode=7`,
        ),
      ),
    );
    assert.equal(result.execution?.exitCode, 7);
    assert.equal(result.judgment.counts.filtered, 1);
    assert.equal(
      result.evidence.map((x) => x.text).join(""),
      "KEEP No test files found\n",
    );
    assert.equal(result.judgment.complete, true);
    const raw = await run(
      env.service.read({
        result_id: result.result_id,
        stream: "stdout",
        offset: 0,
        limit: 1024,
      }),
    );
    assert.equal(raw.data, content);
    await env.store.close();
    await env.store.initialize();
    assert.equal(
      (
        await run(
          env.service.read({
            result_id: result.result_id,
            stream: "stdout",
            offset: 0,
            limit: 1024,
          }),
        )
      ).data,
      content,
    );
  } finally {
    await env.close();
  }
});

test("budget does not silently discard unprocessed ranges; one bad judgment does not erase others", async () => {
  let calls = 0;
  const env = await setup(
    { chunkBytes: 256, outputBytes: 65536, maxJudgments: 2 },
    fake(async ({ source }) => {
      calls++;
      if (source.start === 0) throw new Error("provider internal secret");
      return { probability: 0.9, inputTokens: 1, outputTokens: 0 };
    }),
  );
  try {
    const result = await run(
      env.service.execute(
        nodeCommand(`process.stdout.write('x'.repeat(256*5))`),
      ),
    );
    assert.equal(calls, 2);
    assert.equal(result.judgment.counts.failed, 1);
    assert.equal(result.judgment.counts.unprocessed, 3);
    assert.equal(result.judgment.complete, false);
    assert.equal(result.evidence[0]?.start, 256);
    assert.ok(!JSON.stringify(result).includes("provider internal secret"));
  } finally {
    await env.close();
  }
});

test("invalid probability is a failed judgment, not filtered content", async () => {
  const env = await setup(
    {},
    fake(async () => ({ probability: NaN, inputTokens: 0, outputTokens: 0 })),
  );
  try {
    const result = await run(
      env.service.execute(nodeCommand(`process.stdout.write('evidence')`)),
    );
    assert.equal(result.judgment.counts.failed, 1);
    assert.equal(result.judgment.counts.filtered, 0);
    assert.equal(result.judgment.issues[0]?.reason, "failed:invalid_response");
  } finally {
    await env.close();
  }
});

test("judge timeout aborts pending provider work and returns explicit partial state", async () => {
  let aborted = false;
  const env = await setup(
    { judgeTimeoutMs: 20 },
    fake(
      (_, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    ),
  );
  try {
    const result = await run(
      env.service.execute(nodeCommand(`process.stdout.write('evidence')`)),
    );
    assert.equal(aborted, true);
    assert.equal(result.judgment.issues[0]?.reason, "failed:timeout");
  } finally {
    await env.close();
  }
});

test("cancellation waits for provider cleanup and persists cancelled ranges", async () => {
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let stopped = false;
  const env = await setup(
    {},
    fake(
      (_, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              stopped = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
          notify();
        }),
    ),
  );
  try {
    const controller = new AbortController();
    const pending = run(
      env.service.execute(nodeCommand(`process.stdout.write('evidence')`)),
      { signal: controller.signal },
    );
    const rejection = assert.rejects(pending);
    await started;
    controller.abort();
    await rejection;
    assert.equal(stopped, true);
    const id = (await readdir(env.root)).find((x) => !x.startsWith("."))!;
    const saved = JSON.parse(
      await readFile(join(env.root, id, "manifest.json"), "utf8"),
    );
    assert.equal(saved.records[0].decision.reason, "cancelled");
  } finally {
    await env.close();
  }
});

test("invalid UTF-8 never reaches judge and original bytes remain recoverable", async () => {
  let calls = 0;
  const env = await setup(
    {},
    fake(async () => {
      calls++;
      return { probability: 1, inputTokens: 0, outputTokens: 0 };
    }),
  );
  try {
    const result = await run(
      env.service.execute(
        nodeCommand("process.stdout.write(Buffer.from([255,0,195]))"),
      ),
    );
    assert.equal(calls, 0);
    assert.deepEqual(result.judgment.invalid_streams, ["stdout"]);
    assert.equal(result.judgment.complete, false);
    const read = await run(
      env.service.read({
        result_id: result.result_id,
        stream: "stdout",
        offset: 0,
        limit: 4,
      }),
    );
    assert.equal(read.encoding, "base64");
    assert.deepEqual(
      Buffer.from(read.data, "base64"),
      Buffer.from([255, 0, 195]),
    );
  } finally {
    await env.close();
  }
});

test("simultaneous stdout and stderr are bounded and nonzero exit is preserved", async () => {
  const env = await setup({ outputBytes: 4096, maxJudgments: 1 });
  try {
    const result = await run(
      env.service.execute(
        nodeCommand(
          `setInterval(()=>{process.stdout.write('x'.repeat(4096));process.stderr.write('y'.repeat(4096))},1)`,
        ),
      ),
    );
    assert.equal(result.execution?.status, "output_limit");
    assert.equal(result.execution?.truncated, true);
    assert.equal(
      result.execution!.bytes.stdout + result.execution!.bytes.stderr,
      4096,
    );
  } finally {
    await env.close();
  }
});

test("command deadline terminates process group and retains timeout status", async () => {
  const env = await setup({ commandTimeoutMs: 300 });
  try {
    const result = await run(
      env.service.execute(
        nodeCommand(
          `process.stdout.write(String(process.pid));setInterval(()=>{},1000)`,
        ),
      ),
    );
    assert.equal(result.execution?.status, "timeout");
    const pid = Number(
      (
        await run(
          env.service.read({
            result_id: result.result_id,
            stream: "stdout",
            offset: 0,
            limit: 100,
          }),
        )
      ).data,
    );
    assert.ok(pid > 0);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    await env.close();
  }
});

test("escaped large evidence respects total response budget and UTF-8 pagination", async () => {
  const env = await setup({ responseBytes: 2048, readBytes: 16 });
  try {
    const content = "🙂\u0001".repeat(3000);
    const result = await run(
      env.service.execute(
        nodeCommand(`process.stdout.write(${JSON.stringify(content)})`),
      ),
    );
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 2048);
    assert.equal(result.output_truncated, true);
    let offset = 0,
      raw = "";
    for (;;) {
      const part = await run(
        env.service.read({
          result_id: result.result_id,
          stream: "stdout",
          offset,
          limit: 13,
        }),
      );
      raw += part.data;
      offset = part.next_offset;
      if (part.eof) break;
    }
    assert.equal(raw, content);
    await assert.rejects(
      run(
        env.service.read({
          result_id: result.result_id,
          stream: "stdout",
          offset: 1,
          limit: 13,
        }),
      ),
    );
  } finally {
    await env.close();
  }
});

test("expiry and capacity fail explicitly; read_result cannot traverse paths", async () => {
  let now = 1000;
  const env = await setup(
    { maxResults: 1, retentionMs: 100 },
    fake(),
    () => now,
  );
  try {
    const result = await run(
      env.service.execute(nodeCommand(`process.stdout.write('raw')`)),
    );
    await assert.rejects(run(env.service.execute(nodeCommand(""))), /capacity/);
    await assert.rejects(
      run(
        env.service.read({
          result_id: "../../etc/passwd",
          stream: "stdout",
          offset: 0,
          limit: 4,
        }),
      ),
      /Invalid result ID/,
    );
    now += 101;
    await assert.rejects(
      run(
        env.service.read({
          result_id: result.result_id,
          stream: "stdout",
          offset: 0,
          limit: 4,
        }),
      ),
      /expired/,
    );
    await run(env.service.execute(nodeCommand("")));
    assert.equal(
      (await readdir(env.root)).filter((x) => !x.startsWith(".")).length,
      1,
    );
  } finally {
    await env.close();
  }
});

test("out-of-order judgments still return original byte order with bounded concurrency", async () => {
  let release!: () => void;
  const first = new Promise<void>((resolve) => {
    release = resolve;
  });
  let active = 0,
    peak = 0;
  const env = await setup(
    { outputBytes: 65536, chunkBytes: 256, concurrency: 2 },
    fake(async ({ source }) => {
      active++;
      peak = Math.max(peak, active);
      if (source.start === 0) await first;
      else release();
      active--;
      return { probability: 1, inputTokens: 0, outputTokens: 0 };
    }),
  );
  try {
    const content = "a".repeat(256) + "b".repeat(256) + "c".repeat(256);
    const result = await run(
      env.service.execute(
        nodeCommand(`process.stdout.write(${JSON.stringify(content)})`),
      ),
    );
    assert.equal(peak, 2);
    assert.equal(result.evidence.map((x) => x.text).join(""), content);
  } finally {
    await env.close();
  }
});

test("an adapter that drops source bytes fails explicitly", async () => {
  const env = await setup();
  try {
    const bad = new SiftService(env.config, env.store, fake(), () => ({
      name: "bad",
      index: async () => [],
    }));
    await assert.rejects(
      run(
        bad.execute(nodeCommand(`process.stdout.write('must not disappear')`)),
      ),
      /did not cover/,
    );
  } finally {
    await env.close();
  }
});

test("active read lease prevents expiry cleanup from removing its artifact", async () => {
  let now = 1;
  const env = await setup({ retentionMs: 100 }, fake(), () => now);
  try {
    const result = await run(
      env.service.execute(nodeCommand(`process.stdout.write('source')`)),
    );
    await env.store.lease(result.result_id, async () => {
      now += 101;
      await env.store.cleanup();
      assert.equal(
        await readFile(env.store.path(result.result_id, "stdout"), "utf8"),
        "source",
      );
    });
    await env.store.cleanup();
    await assert.rejects(readFile(env.store.path(result.result_id, "stdout")), {
      code: "ENOENT",
    });
  } finally {
    await env.close();
  }
});

test("missing executable returns spawn_failed without invoking judge", async () => {
  const env = await setup();
  try {
    const result = await run(
      env.service.execute({
        ...nodeCommand(""),
        executable: "/sift-test/nonexistent-executable",
      }),
    );
    assert.equal(result.execution?.status, "spawn_failed");
    assert.equal(result.judgment.requests, 0);
  } finally {
    await env.close();
  }
});

test("timeout stops descendants in the owned process group, including SIGTERM-resistant children", async () => {
  const env = await setup({ commandTimeoutMs: 1000 });
  try {
    const childCode =
      'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)';
    const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:['ignore','pipe','ignore']});c.stdout.once('data',()=>process.stdout.write(String(c.pid)));setInterval(()=>{},1000)`;
    const result = await run(env.service.execute(nodeCommand(code)));
    assert.equal(result.execution?.status, "timeout");
    const raw = await run(
      env.service.read({
        result_id: result.result_id,
        stream: "stdout",
        offset: 0,
        limit: 100,
      }),
    );
    const pid = Number(raw.data);
    assert.ok(pid > 0);
    const state = spawnSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
    });
    assert.ok(
      state.status === 1 || state.stdout.trim().startsWith("Z"),
      `descendant still running: ${state.stdout}`,
    );
  } finally {
    await env.close();
  }
});

test("provider configuration failure is distinguishable from low relevance", async () => {
  const env = await setup(
    {},
    fake(async () => {
      throw failure("JUDGE_CONFIGURATION", "Provider rejected model");
    }),
  );
  try {
    const result = await run(
      env.service.execute(nodeCommand('process.stdout.write("evidence")')),
    );
    assert.equal(result.judgment.complete, false);
    assert.equal(result.judgment.counts.filtered, 0);
    assert.equal(result.judgment.issues[0]?.reason, "failed:configuration");
    assert.equal(result.judgment.model, env.config.model);
  } finally {
    await env.close();
  }
});
