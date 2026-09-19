import { createJevProvider } from "../src/judge.js";

if (!process.env.TYPESAFE_API_KEY)
  throw new Error(
    "TYPESAFE_API_KEY is required for this opt-in billable smoke test.",
  );
const provider = createJevProvider(process.env.TYPESAFE_API_KEY, "jev-1.12");
const prepared = provider.prepare({
  purpose: "Determine whether any test cases ran.",
  command: { executable: "synthetic-test-runner", args: [] },
  source: {
    stream: "stdout",
    start: 0,
    end: 20,
    from: { line: 1, byteColumn: 1 },
    to: { line: 2, byteColumn: 1 },
  },
  before: "Starting tests\n",
  target: "No test files found\n",
  after: "Exit code: 0\n",
});
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10000);
try {
  console.log(
    JSON.stringify({
      adapter: provider.name,
      ...(await prepared.evaluate(controller.signal)),
    }),
  );
} finally {
  clearTimeout(timer);
}
