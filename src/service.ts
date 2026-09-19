import { Effect } from "effect";
import { isAbsolute } from "node:path";
import { stat } from "node:fs/promises";
import { ArtifactStore } from "./store.js";
import {
  boundary,
  decode,
  readBytes,
  windowFor,
  windowStrategy,
  type StrategyResolver,
} from "./chunks.js";
import { executeCommand } from "./executor.js";
import { failure, SiftError } from "./errors.js";
import type { Config } from "./config.js";
import {
  type JudgeProvider,
  type PreparedJudgment,
  validateJudgment,
} from "./judge.js";
import {
  type ChunkRecord,
  type CommandInput,
  type Manifest,
  type OutputStream,
  type Span,
  streams,
} from "./types.js";

function owned<A>(
  work: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, SiftError> {
  return Effect.async<A, SiftError>((resume) => {
    const controller = new AbortController();
    const pending = work(controller.signal);
    pending.then(
      (value) => resume(Effect.succeed(value)),
      (error) =>
        resume(
          Effect.fail(
            error instanceof SiftError
              ? error
              : failure("INTERNAL", "Sift could not finish the operation."),
          ),
        ),
    );
    // Interrupt the external operation and wait for its cleanup before releasing the owner.
    return Effect.promise(async () => {
      controller.abort();
      await pending.catch(() => undefined);
    });
  });
}

export class SiftService {
  private readonly executionLock = Effect.unsafeMakeSemaphore(1);
  constructor(
    readonly config: Config,
    readonly store: ArtifactStore,
    readonly provider: JudgeProvider,
    private readonly strategyFor: StrategyResolver = () => windowStrategy,
  ) {}

  execute(input: CommandInput) {
    return this.executionLock.withPermits(1)(
      owned((signal) => this.run(input, signal)),
    );
  }

  private async run(input: CommandInput, signal: AbortSignal) {
    if (Buffer.byteLength(JSON.stringify(input)) > 65536)
      throw failure("INPUT_LIMIT", "Command input exceeds 64 KiB.");
    if (!isAbsolute(input.cwd) || !(await stat(input.cwd)).isDirectory())
      throw failure("CWD", "cwd must be an existing absolute directory.");
    const manifest = await this.store.create(this.provider.name);
    try {
      manifest.execution = await executeCommand(
        input,
        {
          stdout: this.store.path(manifest.id, "stdout"),
          stderr: this.store.path(manifest.id, "stderr"),
        },
        this.config,
        signal,
      );
      for (const stream of streams) {
        let spans: Span[];
        try {
          spans = await this.strategyFor(input, stream).index(
            this.store.path(manifest.id, stream),
            stream,
            this.config.chunkBytes,
          );
        } catch (error) {
          if (
            error instanceof TypeError &&
            (error as NodeJS.ErrnoException).code ===
              "ERR_ENCODING_INVALID_ENCODED_DATA"
          ) {
            manifest.invalidStreams.push(stream);
            continue;
          }
          throw error;
        }
        let end = 0;
        for (const span of spans) {
          if (
            span.stream !== stream ||
            span.start !== end ||
            !Number.isSafeInteger(span.end) ||
            span.end <= span.start ||
            span.end - span.start > this.config.chunkBytes
          )
            throw failure(
              "CHUNK_CONTRACT",
              "Chunk strategy violated coverage or size bounds.",
            );
          end = span.end;
          manifest.records.push({
            ...span,
            decision: { status: "unprocessed", reason: "budget" },
          });
        }
        if (end !== manifest.execution.bytes[stream])
          throw failure(
            "CHUNK_CONTRACT",
            "Chunk strategy did not cover captured output.",
          );
      }
      await this.judge(input, manifest, signal);
      manifest.state = "complete";
      await this.store.save(manifest);
      return await this.render(manifest);
    } catch (error) {
      manifest.state = "failed";
      await this.store.save(manifest);
      throw error instanceof SiftError
        ? failure(error.code, error.message, manifest.id)
        : failure(
            "INTERNAL",
            "Sift could not finish this result; retained bytes can be read by result ID.",
            manifest.id,
          );
    } finally {
      this.store.releaseExecution(manifest.id);
    }
  }

  private async judge(
    input: CommandInput,
    manifest: Manifest,
    signal: AbortSignal,
  ) {
    const deadline = new AbortController();
    const timer = setTimeout(
      () => deadline.abort(),
      this.config.judgmentDeadlineMs,
    );
    const jobs: Array<{ record: ChunkRecord; prepared: PreparedJudgment }> = [];
    try {
      // Reserve budgets in source order, before concurrent completion can affect selection.
      for (const record of manifest.records) {
        if (signal.aborted || deadline.signal.aborted) {
          record.decision = {
            status: "unprocessed",
            reason: signal.aborted ? "cancelled" : "deadline",
          };
          continue;
        }
        if (jobs.length >= this.config.maxJudgments) continue;
        const window = await windowFor(
          this.store.path(manifest.id, record.stream),
          record,
          manifest.execution!.bytes[record.stream],
          this.config.contextBytes,
        );
        const source: Span = {
          stream: record.stream,
          start: record.start,
          end: record.end,
          from: record.from,
          to: record.to,
        };
        const prepared = this.provider.prepare({
          purpose: input.purpose,
          command: { executable: input.executable, args: input.args },
          source,
          ...window,
        });
        if (
          !Number.isSafeInteger(prepared.inputBytes) ||
          prepared.inputBytes < 0
        )
          throw failure("PROVIDER", "Invalid provider request size.");
        if (
          manifest.inputBytes + prepared.inputBytes >
          this.config.judgmentBytes
        )
          continue;
        manifest.inputBytes += prepared.inputBytes;
        jobs.push({ record, prepared });
      }
      await Effect.runPromise(
        Effect.forEach(
          jobs,
          ({ record, prepared }) =>
            Effect.promise(async () => {
              if (signal.aborted || deadline.signal.aborted) {
                record.decision = {
                  status: "unprocessed",
                  reason: signal.aborted ? "cancelled" : "deadline",
                };
                return;
              }
              const timeout = new AbortController();
              const requestTimer = setTimeout(
                () => timeout.abort(),
                this.config.judgeTimeoutMs,
              );
              const combined = AbortSignal.any([
                signal,
                deadline.signal,
                timeout.signal,
              ]);
              manifest.requests++;
              try {
                const value = validateJudgment(
                  await prepared.evaluate(combined),
                );
                if (combined.aborted)
                  throw failure("CANCELLED", "Judgment cancelled.");
                record.decision = {
                  status: "judged",
                  probability: value.probability,
                };
                manifest.usage.inputTokens += value.inputTokens;
                manifest.usage.outputTokens += value.outputTokens;
              } catch (error) {
                if (signal.aborted || deadline.signal.aborted)
                  record.decision = {
                    status: "unprocessed",
                    reason: signal.aborted ? "cancelled" : "deadline",
                  };
                else
                  record.decision = {
                    status: "failed",
                    reason: timeout.signal.aborted
                      ? "timeout"
                      : error instanceof SiftError &&
                          error.code === "INVALID_JUDGMENT"
                        ? "invalid_response"
                        : "provider",
                  };
              } finally {
                clearTimeout(requestTimer);
              }
            }),
          { concurrency: this.config.concurrency, discard: true },
        ),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async render(manifest: Manifest) {
    const counts = { kept: 0, filtered: 0, failed: 0, unprocessed: 0 };
    const ranges: Array<{
      stream: OutputStream;
      start: number;
      end: number;
      reason: string;
    }> = [];
    const kept: Span[] = [];
    for (const record of manifest.records) {
      if (record.decision.status === "judged") {
        if (record.decision.probability < manifest.threshold) {
          counts.filtered++;
          continue;
        }
        counts.kept++;
        const previous = kept.at(-1);
        if (
          previous &&
          previous.stream === record.stream &&
          previous.end === record.start
        ) {
          previous.end = record.end;
          previous.to = record.to;
        } else
          kept.push({
            stream: record.stream,
            start: record.start,
            end: record.end,
            from: record.from,
            to: record.to,
          });
      } else {
        counts[record.decision.status]++;
        const previous = ranges.at(-1),
          reason = `${record.decision.status}:${record.decision.reason}`;
        if (
          previous &&
          previous.stream === record.stream &&
          previous.end === record.start &&
          previous.reason === reason
        )
          previous.end = record.end;
        else
          ranges.push({
            stream: record.stream,
            start: record.start,
            end: record.end,
            reason,
          });
      }
    }
    const response = {
      result_id: manifest.id,
      expires_at: new Date(manifest.expiresAt).toISOString(),
      execution: manifest.execution,
      judgment: {
        complete:
          counts.failed === 0 &&
          counts.unprocessed === 0 &&
          manifest.invalidStreams.length === 0,
        threshold: manifest.threshold,
        counts,
        invalid_streams: manifest.invalidStreams,
        requests: manifest.requests,
        reserved_input_bytes: manifest.inputBytes,
        usage: manifest.usage,
        issues: ranges.slice(0, 32),
        issues_truncated: ranges.length > 32,
      },
      output_truncated: false,
      evidence: [] as Array<{
        stream: OutputStream;
        start: number;
        end: number;
        text: string;
      }>,
      read_hint:
        "Use read_result with result_id, stream, byte offset and limit. No retained evidence does not prove absence.",
    };
    for (const span of kept) {
      const room =
        this.config.responseBytes -
        Buffer.byteLength(JSON.stringify(response)) -
        128;
      if (room < 4) {
        response.output_truncated = true;
        break;
      }
      const buffer = await readBytes(
        this.store.path(manifest.id, span.stream),
        span.start,
        Math.min(span.end - span.start, room) +
          Math.min(3, Math.max(0, span.end - span.start - room)),
      );
      let length = boundary(buffer, Math.min(buffer.length, room));
      let item = {
        stream: span.stream,
        start: span.start,
        end: span.start + length,
        text: decode(buffer.subarray(0, length)),
      };
      // JSON escaping can expand text by up to six times; cap the actual serialized response.
      while (
        length > 0 &&
        Buffer.byteLength(
          JSON.stringify({
            ...response,
            evidence: [...response.evidence, item],
          }),
        ) > this.config.responseBytes
      ) {
        length = boundary(buffer, Math.floor(length / 2));
        item = {
          ...item,
          end: span.start + length,
          text: decode(buffer.subarray(0, length)),
        };
      }
      if (length) response.evidence.push(item);
      if (span.start + length < span.end) {
        response.output_truncated = true;
        break;
      }
    }
    while (
      Buffer.byteLength(JSON.stringify(response)) > this.config.responseBytes &&
      response.judgment.issues.length
    ) {
      response.judgment.issues.pop();
      response.judgment.issues_truncated = true;
    }
    if (Buffer.byteLength(JSON.stringify(response)) > this.config.responseBytes)
      throw failure(
        "RESPONSE_LIMIT",
        "Response budget is too small for metadata.",
      );
    return response;
  }

  read(input: {
    result_id: string;
    stream: OutputStream;
    offset: number;
    limit: number;
  }) {
    return owned(() =>
      this.store.lease(input.result_id, async (manifest) => {
        if (input.limit > this.config.readBytes)
          throw failure("READ_LIMIT", "Requested read exceeds server limit.");
        const path = this.store.path(input.result_id, input.stream),
          size = (await stat(path)).size;
        if (input.offset > size)
          throw failure("RANGE", "Offset exceeds source length.");
        const length = Math.min(input.limit, size - input.offset);
        const buffer = await readBytes(
          path,
          input.offset,
          Math.min(size - input.offset, length + 3),
        );
        const invalid =
          manifest.invalidStreams.includes(input.stream) ||
          manifest.state === "failed";
        let consumed: number, text: string;
        if (invalid) {
          consumed = length;
          text = buffer.subarray(0, length).toString("base64");
        } else {
          consumed = boundary(buffer, length);
          try {
            text = decode(buffer.subarray(0, consumed));
          } catch {
            throw failure(
              "UTF8_BOUNDARY",
              "Offset must point to the start of a UTF-8 code point.",
            );
          }
          if (!consumed && length)
            throw failure(
              "READ_LIMIT",
              "Increase limit to fit a UTF-8 code point.",
            );
        }
        return {
          result_id: manifest.id,
          stream: input.stream,
          offset: input.offset,
          next_offset: input.offset + consumed,
          total_bytes: size,
          eof: input.offset + consumed === size,
          encoding: invalid ? "base64" : "utf8",
          data: text,
        };
      }),
    );
  }
}
