import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Effect } from "effect";
import { z } from "zod";
import { SiftError } from "./errors.js";
import type { SiftService } from "./service.js";

export function createMcpServer(service: SiftService) {
  const server = new McpServer({ name: "sift", version: "0.1.0" });
  const shutdown = new AbortController();
  const pending = new Set<Promise<unknown>>();
  const text = (value: unknown, isError = false) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
    isError,
  });
  async function invoke<A>(
    effect: Effect.Effect<A, SiftError>,
    signal: AbortSignal,
  ) {
    const run = Effect.runPromise(
      Effect.match(effect, {
        onFailure: (error) =>
          text(
            {
              error: error.code,
              message: error.message,
              ...(error.resultId ? { result_id: error.resultId } : {}),
            },
            true,
          ),
        onSuccess: (value) => text(value),
      }),
      { signal: AbortSignal.any([signal, shutdown.signal]) },
    );
    pending.add(run);
    try {
      return await run;
    } catch {
      return text(
        {
          error: "CANCELLED",
          message: "Operation interrupted; owned resources are being released.",
        },
        true,
      );
    } finally {
      pending.delete(run);
    }
  }
  const argument = z
    .string()
    .max(16384)
    .refine((value) => !value.includes("\0"), "NUL is not allowed");
  server.registerTool(
    "execute",
    {
      description:
        'Execute a finite non-interactive command and select original output evidence for a stated purpose. Runs with host permissions, not a sandbox. Sends output windows to the configured judgment provider. Filtering can omit evidence; an empty result does not prove absence. For shell pipelines explicitly execute /bin/sh with args ["-c", "..."]; commands are never retried.',
      inputSchema: z
        .object({
          executable: argument.min(1),
          args: z.array(argument).max(128),
          cwd: argument.min(1),
          purpose: z.string().min(1).max(4096),
        })
        .strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    (input, extra) => invoke(service.execute(input), extra.signal),
  );
  server.registerTool(
    "read_result",
    {
      description: `Read retained original output by byte range. Limit is at most ${service.config.readBytes} bytes. Follow next_offset for UTF-8-safe pagination. Invalid UTF-8 sources are explicitly base64 encoded. Missing or expired results report an error.`,
      inputSchema: z
        .object({
          result_id: z.string().uuid(),
          stream: z.enum(["stdout", "stderr"]),
          offset: z.number().int().min(0).safe(),
          limit: z.number().int().min(4).max(service.config.readBytes),
        })
        .strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    (input, extra) => invoke(service.read(input), extra.signal),
  );
  return {
    server,
    async close() {
      shutdown.abort();
      await Promise.allSettled([...pending]);
      await server.close();
    },
  };
}
