import { basename } from "node:path";
import {
  indexFile,
  readBytes,
  decode,
  windowStrategy,
  type ChunkStrategy,
  type StrategyResolver,
} from "./chunks.js";
import type { OutputStream, Span } from "./types.js";
import { failure } from "./errors.js";

// Cap packed records so a single useful match is not diluted in an 8 KiB target.
const recordBytes = 1024;
async function indexRecords(
  path: string,
  stream: OutputStream,
  limit: number,
  format: "tap" | "lines",
): Promise<Span[]> {
  const cap = Math.min(limit, recordBytes);
  const windows = await indexFile(path, stream, cap);
  const result: Span[] = [];
  let unit: Span | undefined, packed: Span | undefined;
  let kind = "header",
    packedKind = "";
  function flushPacked() {
    if (!packed) return;
    if (result.length >= 4096)
      throw failure(
        "CHUNK_LIMIT",
        "Structured output exceeds 4096 chunks; raw output remains available.",
      );
    result.push(packed);
    packed = undefined;
  }
  function flushUnit() {
    if (!unit) return;
    if (packed && packedKind === kind && unit.end - packed.start <= cap)
      packed = { ...packed, end: unit.end, to: unit.to };
    else {
      flushPacked();
      packed = unit;
      packedKind = kind;
    }
    unit = undefined;
  }
  for (const window of windows) {
    const bytes = await readBytes(
      path,
      window.start,
      window.end - window.start,
    );
    let start = 0,
      position = window.from;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline + 1;
      const text = decode(bytes.subarray(start, end));
      if (format === "tap" && position.byteColumn === 1) {
        const nextKind = /^# Subtest:/.test(text)
          ? "test"
          : /^1\.\.\d+(?:\s|$)/.test(text)
            ? "summary"
            : undefined;
        if (nextKind) {
          flushUnit();
          kind = nextKind;
        }
      }
      const to =
        newline < 0
          ? {
              line: position.line,
              byteColumn: position.byteColumn + end - start,
            }
          : { line: position.line + 1, byteColumn: 1 };
      const fragment: Span = {
        stream,
        start: window.start + start,
        end: window.start + end,
        from: position,
        to,
      };
      if (unit && fragment.end - unit.start > cap) flushUnit();
      unit = unit ? { ...unit, end: fragment.end, to } : fragment;
      if (format === "lines") flushUnit();
      position = to;
      start = end;
    }
  }
  flushUnit();
  flushPacked();
  return result;
}

export const tapStrategy: ChunkStrategy = {
  name: "node-tap-records-v1",
  index: (path, stream, limit) => indexRecords(path, stream, limit, "tap"),
};
export const searchStrategy: ChunkStrategy = {
  name: "rg-line-groups-v1",
  index: (path, stream, limit) => indexRecords(path, stream, limit, "lines"),
};

/** Only direct known formats are selected; shell wrappers are never guessed. */
export const commandStrategy: StrategyResolver = (command, stream) => {
  if (stream !== "stdout") return windowStrategy;
  const name = basename(command.executable),
    args = command.args;
  if (
    name === "node" &&
    args[0] === "--test" &&
    args[1] === "--test-reporter=tap" &&
    args.slice(2).every((arg) => !arg.startsWith("-"))
  )
    return tapStrategy;
  // Explicit line-number text mode; JSON, multiline and NUL formats keep generic windows.
  if (
    name === "rg" &&
    args[0] === "--line-number" &&
    args.slice(1).every((arg) => !arg.startsWith("-"))
  )
    return searchStrategy;
  return windowStrategy;
};
