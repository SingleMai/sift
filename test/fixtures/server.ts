import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setup, fake } from "../helpers.js";
import { createMcpServer } from "../../src/mcp.js";

// Test-only executable; production CLI cannot select this provider.
const env = await setup(
  {},
  fake(async ({ target }) => ({
    probability: target.includes("KEEP") ? 0.95 : 0.1,
    inputTokens: 1,
    outputTokens: 1,
  })),
);
const app = createMcpServer(env.service);
let closing = false;
const close = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  await env.close();
};
app.server.server.onclose = () => {
  void close();
};
process.once("SIGTERM", () => {
  void close();
});
process.stdin.once("end", () => {
  void close();
});
await app.server.connect(new StdioServerTransport());
