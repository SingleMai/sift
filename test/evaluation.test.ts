import test from "node:test";
import assert from "node:assert/strict";
import { scoreEvidence, responseSizes } from "../eval/metrics.js";

test("evaluation cannot reconstruct decisive evidence across an omitted gap or stream", () => {
  const sources = { stdout: "timeout=5000", stderr: "timeout=5000" };
  const expected = [{ stream: "stdout" as const, text: "timeout=5000" }];
  assert.equal(
    scoreEvidence(
      sources,
      [
        { stream: "stdout", start: 0, end: 8, text: "timeout=" },
        { stream: "stdout", start: 9, end: 12, text: "000" },
        { stream: "stderr", start: 0, end: 12, text: "timeout=5000" },
      ],
      expected,
    )[0]!.retained,
    false,
  );
  assert.equal(
    scoreEvidence(
      sources,
      [
        { stream: "stdout", start: 0, end: 8, text: "timeout=" },
        { stream: "stdout", start: 8, end: 12, text: "5000" },
      ],
      expected,
    )[0]!.retained,
    true,
  );
  assert.throws(() =>
    scoreEvidence(
      sources,
      [{ stream: "stdout", start: 0, end: 12, text: "timeout=9000" }],
      expected,
    ),
  );
  assert.throws(() =>
    scoreEvidence(sources, [], [{ stream: "stdout", text: "missing" }]),
  );
});

test("response measurement includes metadata and JSON escaping rather than source bytes alone", () => {
  const sizes = responseSizes(
    {
      content: [{ type: "text", text: "metadata".repeat(100) }],
      isError: false,
    },
    { exitCode: 0 },
    { stdout: "a\n", stderr: "" },
  );
  assert.ok(sizes.filteredBytes > sizes.unfilteredBytes);
  assert.ok(sizes.reduction < 0);
});
