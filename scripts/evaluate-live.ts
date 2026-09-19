import { mkdir, readFile, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { Effect, Schema } from "effect";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { defaults } from "../src/config.js";
import { JevProvider } from "../src/judge.js";

const Case = Schema.Struct({
  id: Schema.String,
  purpose: Schema.String,
  before: Schema.String,
  target: Schema.String,
  after: Schema.String,
  expectedRelevant: Schema.Boolean,
});
const cases = Schema.decodeUnknownSync(Schema.Array(Case))(
  JSON.parse(
    await readFile(new URL("../eval/cases.json", import.meta.url), "utf8"),
  ),
);
if (!process.env.TYPESAFE_API_KEY)
  throw new Error(
    "TYPESAFE_API_KEY is required for this opt-in billable evaluation.",
  );
const client = new TypeSafeClient({
  apiKey: process.env.TYPESAFE_API_KEY,
  logLevel: "off",
  retry: { maxRetries: 0 },
});
const available = await client.models.list();
if (!available.some((model) => model.name === defaults.model))
  throw new Error(`Configured model ${defaults.model} is unavailable.`);
const provider = new JevProvider(client, defaults.model);
const start = performance.now();
const rows = await Effect.runPromise(
  Effect.forEach(
    cases,
    (item) =>
      Effect.promise(async () => {
        const targetBytes = Buffer.byteLength(item.target);
        const prepared = provider.prepare({
          purpose: item.purpose,
          command: { executable: "synthetic-evaluation", args: [] },
          source: {
            stream: "stdout",
            start: 0,
            end: targetBytes,
            from: { line: 1, byteColumn: 1 },
            to: { line: 2, byteColumn: 1 },
          },
          before: item.before,
          target: item.target,
          after: item.after,
        });
        const controller = new AbortController(),
          timer = setTimeout(() => controller.abort(), 10000),
          began = performance.now();
        try {
          return {
            id: item.id,
            expectedRelevant: item.expectedRelevant,
            ...(await prepared.evaluate(controller.signal)),
            durationMs: performance.now() - began,
          };
        } finally {
          clearTimeout(timer);
        }
      }),
    { concurrency: 4 },
  ),
);
const thresholds = [0.5, 0.6, 0.7, 0.8, 0.9, 0.95].map((threshold) => {
  let tp = 0,
    fp = 0,
    fn = 0,
    tn = 0;
  for (const row of rows) {
    const keep = row.probability >= threshold;
    if (row.expectedRelevant) {
      if (keep) tp++;
      else fn++;
    } else {
      if (keep) fp++;
      else tn++;
    }
  }
  return {
    threshold,
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp ? tp / (tp + fp) : null,
    recall: tp / (tp + fn),
  };
});
const result = {
  recordedAt: new Date().toISOString(),
  model: defaults.model,
  availableModels: available,
  fixture: "eval/cases.json",
  limitation:
    "16 assistant-authored synthetic expectations; development pilot, not independent human labels or held-out calibration.",
  durationMs: performance.now() - start,
  inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
  outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
  thresholds,
  rows,
};
await mkdir(".tmp", { recursive: true });
await writeFile(".tmp/live-evaluation.json", JSON.stringify(result, null, 2));
console.log(
  JSON.stringify({
    model: result.model,
    cases: rows.length,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    thresholds,
  }),
);
