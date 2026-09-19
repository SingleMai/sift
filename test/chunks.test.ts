import test from "node:test";
import assert from "node:assert/strict";
import { chunkBytes, decode, windowFor } from "../src/chunks.js";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function* slices(buffer: Buffer, size: number) {
  for (let n = 0; n < buffer.length; n += size)
    yield buffer.subarray(n, n + size);
}

test("chunk coverage and UTF-8 integrity survive all small read boundaries", async () => {
  for (const content of [
    "",
    "a\r\nb\nlast",
    "\ufeff中文🙂\r\n尾巴",
    "🙂".repeat(1000),
    "x".repeat(70000) + "\n末尾",
  ]) {
    const bytes = Buffer.from(content);
    for (const readSize of [1, 2, 3, 7, 127, 65536]) {
      const chunks = [];
      for await (const chunk of chunkBytes(
        slices(bytes, readSize),
        "stdout",
        64,
      ))
        chunks.push(chunk);
      let offset = 0,
        reconstructed = "";
      for (const chunk of chunks) {
        assert.equal(chunk.start, offset);
        assert.ok(chunk.end - chunk.start <= 64);
        reconstructed += decode(bytes.subarray(chunk.start, chunk.end));
        offset = chunk.end;
      }
      assert.equal(offset, bytes.length);
      assert.equal(reconstructed, content);
    }
  }
});

test("invalid and incomplete UTF-8 are rejected instead of silently repaired", async () => {
  for (const bytes of [
    Buffer.from([0xff]),
    Buffer.from([0xe4, 0xb8]),
    Buffer.from([0xc0, 0xaf]),
  ]) {
    await assert.rejects(async () => {
      for await (const _ of chunkBytes(slices(bytes, 1), "stdout", 16)) {
      }
    }, TypeError);
  }
});

test("neighbor context stays UTF-8 aligned and source positions preserve byte columns", async () => {
  const root = await mkdtemp(join(tmpdir(), "sift-chunks-"));
  try {
    const content = Buffer.from("前🙂\n" + "中🙂".repeat(100) + "\n结束");
    const file = join(root, "raw");
    await writeFile(file, content);
    for await (const span of chunkBytes(slices(content, 11), "stderr", 32)) {
      const view = await windowFor(file, span, content.length, 5);
      assert.equal(view.target, decode(content.subarray(span.start, span.end)));
      assert.ok(
        !view.before.includes("\ufffd") && !view.after.includes("\ufffd"),
      );
      const prefix = content.subarray(0, span.start);
      assert.equal(
        span.from.line,
        prefix.filter((byte) => byte === 10).length + 1,
      );
      assert.equal(
        span.from.byteColumn,
        prefix.length - prefix.lastIndexOf(10),
      );
    }
  } finally {
    await rm(root, { recursive: true });
  }
});
