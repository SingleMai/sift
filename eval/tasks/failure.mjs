import test from "node:test";
import assert from "node:assert/strict";

// Deliberate failure: these public fixtures are inputs to evaluation, not Sift tests.
for (let i = 0; i < 24; i++)
  test(`healthy case ${i}`, () => assert.equal(1, 1));
test("payment transitions to paid", () => assert.equal("pending", "paid"));
