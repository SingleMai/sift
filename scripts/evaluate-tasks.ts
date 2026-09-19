import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaults } from "../src/config.js";
import { scoreEvidence, responseSizes } from "../eval/metrics.js";

const stream = z.enum(["stdout", "stderr"]);
const tasks = z
  .array(
    z.object({
      id: z.string(),
      executable: z.enum(["node", "rg"]),
      args: z.array(z.string()),
      purpose: z.string(),
      exitCode: z.number(),
      required: z.array(z.object({ stream, text: z.string() })),
    }),
  )
  .parse(JSON.parse(await readFile("eval/tasks.json", "utf8")));
const resultSchema = z.object({
  result_id: z.string().uuid(),
  execution: z
    .object({
      exitCode: z.number(),
      durationMs: z.number(),
      truncated: z.boolean(),
    })
    .passthrough(),
  judgment: z
    .object({
      complete: z.boolean(),
      requests: z.number(),
      usage: z.object({ inputTokens: z.number(), outputTokens: z.number() }),
    })
    .passthrough(),
  output_truncated: z.boolean(),
  evidence: z.array(
    z.object({ stream, start: z.number(), end: z.number(), text: z.string() }),
  ),
});
if (!process.env.TYPESAFE_API_KEY)
  throw new Error(
    "TYPESAFE_API_KEY required for opt-in billable task evaluation",
  );
const rows = [];
const artifactDir = join(
  ".tmp",
  "task-evaluation-artifacts",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(artifactDir, { recursive: true, mode: 0o700 });
for (const chunkBytes of [1024, defaults.chunkBytes]) {
  const root = await mkdtemp(join(tmpdir(), "sift-task-eval-"));
  const config = join(root, "config.json"),
    stateDir = join(root, "artifacts");
  await writeFile(
    config,
    JSON.stringify({
      stateDir,
      threshold: 0.8,
      chunkBytes,
      outputBytes: 65536,
    }),
    { mode: 0o600 },
  );
  const client = new Client({ name: "sift-task-evaluation", version: "1" });
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
  try {
    await client.connect(transport);
    for (const task of tasks) {
      const start = performance.now();
      const raw = await client.callTool({
        name: "execute",
        arguments: {
          executable:
            task.executable === "node" ? process.execPath : task.executable,
          args: task.args,
          cwd: process.cwd(),
          purpose: task.purpose,
        },
      });
      const durationMs = performance.now() - start;
      assert.equal(raw.isError, false);
      const content = z
        .array(z.object({ type: z.literal("text"), text: z.string() }))
        .parse(raw.content);
      const value = resultSchema.parse(JSON.parse(content[0]!.text));
      assert.equal(value.execution.exitCode, task.exitCode);
      assert.equal(value.execution.truncated, false);
      const sources = {
        stdout: await readFile(
          join(stateDir, value.result_id, "stdout"),
          "utf8",
        ),
        stderr: await readFile(
          join(stateDir, value.result_id, "stderr"),
          "utf8",
        ),
      };
      await writeFile(
        join(artifactDir, `${task.id}-${chunkBytes}.json`),
        JSON.stringify({
          task,
          chunkBytes,
          contextBytes: defaults.contextBytes,
          model: defaults.model,
          result: raw,
          sources,
        }),
        { mode: 0o600 },
      );
      const required = scoreEvidence(sources, value.evidence, task.required);
      const manifest = JSON.parse(
        await readFile(
          join(stateDir, value.result_id, "manifest.json"),
          "utf8",
        ),
      );
      const row = {
        task: task.id,
        chunkBytes,
        contextBytes: defaults.contextBytes,
        threshold: 0.8,
        durationMs,
        commandDurationMs: value.execution.durationMs,
        addedDurationMs: durationMs - value.execution.durationMs,
        judgment: value.judgment,
        outputTruncated: value.output_truncated,
        required,
        allRequiredRetained: required.every((item) => item.retained),
        capturedBytes:
          Buffer.byteLength(sources.stdout) + Buffer.byteLength(sources.stderr),
        selectedBytes: value.evidence.reduce(
          (sum, span) => sum + Buffer.byteLength(span.text),
          0,
        ),
        response: responseSizes(raw, value.execution, sources),
        probabilities: manifest.records.map(
          (record: {
            stream: string;
            start: number;
            end: number;
            decision: unknown;
          }) => ({
            stream: record.stream,
            start: record.start,
            end: record.end,
            decision: record.decision,
          }),
        ),
      };
      rows.push(row);
      console.log(
        JSON.stringify({
          task: row.task,
          chunkBytes,
          allRequiredRetained: row.allRequiredRetained,
          responseReduction: row.response.reduction,
          addedDurationMs: row.addedDurationMs,
          requests: row.judgment.requests,
        }),
      );
    }
    assert.equal(diagnostics, "");
  } finally {
    try {
      await client.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}
await mkdir(".tmp", { recursive: true });
await writeFile(
  ".tmp/task-evaluation.json",
  JSON.stringify(
    {
      recordedAt: new Date().toISOString(),
      model: defaults.model,
      fixture: "eval/tasks.json",
      limitation:
        "Assistant-authored development scenarios using real Node test runner and ripgrep output plus synthetic cross-boundary JSON. One run per configuration, no independent labels, no main-model outcome or token measurement. Baseline is an explicit unfiltered tool-result object, not an existing host integration. Raw verification uses local disk and is not returned to the caller.",
      qualityPassed: rows.every(
        (row) =>
          row.allRequiredRetained &&
          row.judgment.complete &&
          !row.outputTruncated,
      ),
      rows,
    },
    null,
    2,
  ),
);

if (
  rows.some(
    (row) =>
      !row.allRequiredRetained || !row.judgment.complete || row.outputTruncated,
  )
) {
  console.error(
    "Task quality evaluation failed; see .tmp/task-evaluation.json. Raw inputs and responses are retained locally under .tmp/task-evaluation-artifacts/.",
  );
  process.exitCode = 1;
}
