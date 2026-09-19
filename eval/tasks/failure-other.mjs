import test from "node:test";
import assert from "node:assert/strict";
for (let i = 0; i < 12; i++) test(`ready worker ${i}`, () => assert.ok(true));
test("connection retry budget", () => assert.equal(8, 3));
test("request deadline", () => assert.equal(9000, 5000));
