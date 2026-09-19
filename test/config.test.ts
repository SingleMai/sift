import test from "node:test";
import assert from "node:assert/strict";
import { defaults, loadConfig, validateConfig } from "../src/config.js";
import { ArtifactStore } from "../src/store.js";
import { setup } from "./helpers.js";

test("threshold has no silent default and invalid budgets are rejected", async () => {
  assert.throws(() => validateConfig(defaults));
  for (const threshold of [NaN, -1, 1.1, "0.8"])
    assert.throws(() => validateConfig({ ...defaults, threshold }));
  await assert.rejects(loadConfig({ SIFT_THRESHOLD: "" }));
  assert.throws(() =>
    validateConfig({ ...defaults, threshold: 0.8, responseBytes: 1 }),
  );
});

test("single store owner is enforced; closing another instance cannot remove its lock", async () => {
  const env = await setup();
  try {
    const other = new ArtifactStore(env.config);
    await assert.rejects(other.initialize(), /locked/);
    await other.close();
    await assert.rejects(other.initialize(), /locked/);
  } finally {
    await env.close();
  }
});
