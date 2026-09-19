import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { defaults, validateConfig, type Config } from "../src/config.js";
import { ArtifactStore } from "../src/store.js";
import { SiftService } from "../src/service.js";
import type { JudgeInput, JudgeProvider, Judgment } from "../src/judge.js";
import type { CommandInput } from "../src/types.js";

export function fake(
  judge: (
    input: JudgeInput,
    signal: AbortSignal,
  ) => Promise<Judgment> = async () => ({
    probability: 1,
    inputTokens: 1,
    outputTokens: 1,
  }),
): JudgeProvider {
  return {
    name: "test-only",
    prepare: (input) => ({
      inputBytes: Buffer.byteLength(JSON.stringify(input)),
      evaluate: (signal) => judge(input, signal),
    }),
  };
}
export async function setup(
  overrides: Partial<Config> = {},
  provider = fake(),
  now?: () => number,
) {
  const root = await mkdtemp(join(tmpdir(), "sift-test-"));
  const config = validateConfig({
    ...defaults,
    stateDir: root,
    threshold: 0.8,
    ...overrides,
  });
  const store = new ArtifactStore(config, now);
  await store.initialize();
  return {
    root,
    config,
    store,
    service: new SiftService(config, store, provider),
    async close() {
      await store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
export function nodeCommand(code: string, cwd = process.cwd()): CommandInput {
  return {
    executable: process.execPath,
    args: ["-e", code],
    cwd,
    purpose: "Find relevant evidence including counterexamples",
  };
}
export const run = Effect.runPromise;
