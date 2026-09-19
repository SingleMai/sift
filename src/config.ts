import { Schema } from "effect";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { readFile } from "node:fs/promises";
import { failure } from "./errors.js";

const positive = Schema.Int.pipe(Schema.between(1, Number.MAX_SAFE_INTEGER));
export const ConfigSchema = Schema.Struct({
  stateDir: Schema.String,
  threshold: Schema.Number.pipe(Schema.between(0, 1)),
  model: Schema.NonEmptyString,
  chunkStrategy: Schema.Literal("window", "command"),
  commandTimeoutMs: positive,
  judgeTimeoutMs: positive,
  judgmentDeadlineMs: positive,
  outputBytes: positive,
  chunkBytes: positive,
  contextBytes: Schema.Int.pipe(Schema.between(0, 65536)),
  concurrency: positive,
  maxJudgments: positive,
  judgmentBytes: positive,
  responseBytes: positive,
  readBytes: positive,
  retentionMs: positive,
  storageBytes: positive,
  maxResults: positive,
});
export type Config = typeof ConfigSchema.Type;
export const defaults = {
  stateDir: join(homedir(), ".local", "share", "sift"),
  model: "jev-latest",
  chunkStrategy: "window" as const,
  commandTimeoutMs: 30_000,
  judgeTimeoutMs: 10_000,
  judgmentDeadlineMs: 60_000,
  outputBytes: 8 * 1024 * 1024,
  chunkBytes: 8192,
  contextBytes: 2048,
  concurrency: 4,
  maxJudgments: 128,
  judgmentBytes: 2 * 1024 * 1024,
  responseBytes: 24 * 1024,
  readBytes: 24 * 1024,
  retentionMs: 24 * 60 * 60 * 1000,
  storageBytes: 256 * 1024 * 1024,
  maxResults: 100,
};

export function validateConfig(value: unknown): Config {
  let config: Config;
  try {
    config = Schema.decodeUnknownSync(ConfigSchema)(value, {
      onExcessProperty: "error",
    });
  } catch {
    throw failure(
      "CONFIG",
      "Invalid configuration; threshold must be explicitly configured in [0,1].",
    );
  }
  if (
    !isAbsolute(config.stateDir) ||
    config.chunkBytes < 256 ||
    config.chunkBytes > 65536 ||
    config.outputBytes > 64 * 1024 * 1024 ||
    Math.ceil(config.outputBytes / config.chunkBytes) > 4096 ||
    config.concurrency > 16 ||
    config.maxJudgments > 4096 ||
    config.maxResults > 1000 ||
    Math.max(
      config.commandTimeoutMs,
      config.judgeTimeoutMs,
      config.judgmentDeadlineMs,
    ) > 3600000 ||
    config.readBytes < 4 ||
    config.readBytes > 1024 * 1024 ||
    config.responseBytes < 2048 ||
    config.responseBytes > 1024 * 1024 ||
    config.storageBytes < config.outputBytes + 8 * 1024 * 1024
  ) {
    throw failure(
      "CONFIG",
      "Configuration exceeds supported bounds; see docs/configuration.md.",
    );
  }
  return config;
}

export async function loadConfig(env = process.env): Promise<Config> {
  let raw: unknown = {};
  if (env.SIFT_CONFIG)
    raw = JSON.parse(await readFile(env.SIFT_CONFIG, "utf8"));
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw failure("CONFIG", "Config must be a JSON object.");
  if (env.SIFT_THRESHOLD !== undefined && !env.SIFT_THRESHOLD.trim())
    throw failure("CONFIG", "SIFT_THRESHOLD must be a number.");
  return validateConfig({
    ...defaults,
    ...raw,
    ...(env.SIFT_STATE_DIR ? { stateDir: env.SIFT_STATE_DIR } : {}),
    ...(env.SIFT_THRESHOLD !== undefined
      ? { threshold: Number(env.SIFT_THRESHOLD) }
      : {}),
  });
}
