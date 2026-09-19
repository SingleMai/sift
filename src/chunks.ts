import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import type { CommandInput, OutputStream, Position, Span } from "./types.js";

export interface ChunkStrategy {
  readonly name: string;
  index(path: string, stream: OutputStream, limit: number): Promise<Span[]>;
}
export type StrategyResolver = (
  command: CommandInput,
  stream: OutputStream,
) => ChunkStrategy;
export const windowStrategy: ChunkStrategy = {
  name: "utf8-window-v1",
  index: indexFile,
};

const continuation = (byte: number | undefined) =>
  byte !== undefined && (byte & 0xc0) === 0x80;
export function boundary(buffer: Buffer, desired: number): number {
  let end = Math.min(desired, buffer.length);
  while (end > 0 && end < buffer.length && continuation(buffer[end])) end--;
  return end;
}
export function decode(buffer: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    buffer,
  );
}
function advance(position: Position, buffer: Buffer): Position {
  let { line, byteColumn } = position;
  for (const byte of buffer) {
    if (byte === 10) {
      line++;
      byteColumn = 1;
    } else byteColumn++;
  }
  return { line, byteColumn };
}

/** Keeps at most one read buffer plus a target window; offsets refer to untouched bytes. */
export async function* chunkBytes(
  input: AsyncIterable<Buffer>,
  stream: OutputStream,
  limit: number,
): AsyncGenerator<Span> {
  if (!Number.isInteger(limit) || limit < 4)
    throw new RangeError("Chunk limit must be at least 4 bytes.");
  const validator = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let pending = Buffer.alloc(0),
    offset = 0,
    position: Position = { line: 1, byteColumn: 1 };
  for await (const incoming of input) {
    validator.decode(incoming, { stream: true });
    pending = Buffer.concat([pending, incoming]);
    while (pending.length > limit) {
      const newline = pending.lastIndexOf(10, limit - 1);
      const cut = newline >= 0 ? newline + 1 : boundary(pending, limit);
      const endPosition = advance(position, pending.subarray(0, cut));
      yield {
        stream,
        start: offset,
        end: offset + cut,
        from: position,
        to: endPosition,
      };
      pending = pending.subarray(cut);
      offset += cut;
      position = endPosition;
    }
  }
  validator.decode();
  if (pending.length)
    yield {
      stream,
      start: offset,
      end: offset + pending.length,
      from: position,
      to: advance(position, pending),
    };
}

export async function indexFile(
  path: string,
  stream: OutputStream,
  limit: number,
): Promise<Span[]> {
  const spans: Span[] = [];
  for await (const span of chunkBytes(
    createReadStream(path, { highWaterMark: 65536 }),
    stream,
    limit,
  ))
    spans.push(span);
  return spans;
}

export async function readBytes(
  path: string,
  start: number,
  length: number,
): Promise<Buffer> {
  const file = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const result = await file.read(buffer, read, length - read, start + read);
      if (!result.bytesRead) throw new Error("Unexpected EOF");
      read += result.bytesRead;
    }
    return buffer;
  } finally {
    await file.close();
  }
}

export async function windowFor(
  path: string,
  span: Span,
  size: number,
  context: number,
) {
  const lo = Math.max(0, span.start - context),
    hi = Math.min(size, span.end + context);
  const buffer = await readBytes(path, lo, Math.min(size, hi + 3) - lo);
  let start = 0;
  while (continuation(buffer[start])) start++;
  const end = boundary(buffer, hi - lo);
  return {
    before: decode(buffer.subarray(start, span.start - lo)),
    target: decode(buffer.subarray(span.start - lo, span.end - lo)),
    after: decode(buffer.subarray(span.end - lo, end)),
  };
}
