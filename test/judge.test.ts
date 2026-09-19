import test from "node:test";
import assert from "node:assert/strict";
import { TypeSafeClient } from "@typesafe-ai/sdk";
import { JevProvider } from "../src/judge.js";

const input = {
  purpose: "Did tests actually execute?",
  command: { executable: "test", args: [] },
  source: {
    stream: "stdout" as const,
    start: 0,
    end: 19,
    from: { line: 1, byteColumn: 1 },
    to: { line: 2, byteColumn: 1 },
  },
  before: "",
  target: "No test files found",
  after: "exit 0",
};

test("Jev adapter uses Noul and preserves the query/target distinction through the real SDK", async () => {
  let request: any;
  const provider = new JevProvider(
    new TypeSafeClient({
      apiKey: "test-only",
      logLevel: "off",
      fetch: async (_, init) => {
        request = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: "jev-1.12",
            answers: { relevant: { type: "noul", noul: 0.93 } },
            usage: { input_tokens: 10, output_tokens: 3 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    }),
    "jev-1.12",
  );
  const prepared = provider.prepare(input);
  const answer = await prepared.evaluate(new AbortController().signal);
  assert.equal(answer.probability, 0.93);
  assert.equal(answer.inputTokens, 10);
  assert.equal(request.questions.relevant.type, "noul");
  assert.equal(request.state.target, input.target);
  assert.equal(request.state.after, input.after);
  assert.equal(request.state.purpose, input.purpose);
  assert.equal(prepared.inputBytes, Buffer.byteLength(JSON.stringify(request)));
});

test("Jev adapter disables SDK retries and propagates cancellation to transport", async () => {
  let calls = 0;
  const provider = new JevProvider(
    new TypeSafeClient({
      apiKey: "test-only",
      logLevel: "off",
      fetch: async () => {
        calls++;
        return new Response("{}", { status: 503 });
      },
    }),
    "jev-1.12",
  );
  await assert.rejects(
    provider.prepare(input).evaluate(new AbortController().signal),
  );
  assert.equal(calls, 1);
  let notify!: () => void;
  const started = new Promise<void>((resolve) => {
    notify = resolve;
  });
  let aborted = false;
  const cancelProvider = new JevProvider(
    new TypeSafeClient({
      apiKey: "test-only",
      logLevel: "off",
      fetch: (_, init) =>
        new Promise((_, reject) => {
          init!.signal!.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
          );
          notify();
        }),
    }),
    "jev-1.12",
  );
  const controller = new AbortController();
  const pending = cancelProvider.prepare(input).evaluate(controller.signal);
  const rejected = assert.rejects(pending);
  await started;
  controller.abort();
  await rejected;
  assert.equal(aborted, true);
});
