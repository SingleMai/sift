#!/usr/bin/env node
import { version } from "./version.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Effect } from "effect";
import { loadConfig } from "./config.js";
import { attempt, failure, SiftError } from "./errors.js";
import { createJevProvider } from "./judge.js";
import { ArtifactStore } from "./store.js";
import { SiftService } from "./service.js";
import { createMcpServer } from "./mcp.js";

const args = process.argv.slice(2);
if (args.length) {
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${version}\n`);
    process.exit(0);
  }
  if (args.length === 1 && args[0] === "--help") {
    process.stdout.write(
      `Sift ${version} — local stdio MCP server\n\nUsage: sift [--help | --version]\nWithout arguments, serves execute and read_result over stdio.\nRequires TYPESAFE_API_KEY and an explicit threshold via SIFT_THRESHOLD or SIFT_CONFIG.\nSIFT_CONFIG points to a JSON configuration file; SIFT_STATE_DIR overrides artifact storage.\nSee https://github.com/SingleMai/sift/blob/v${version}/docs/preview.md\n`,
    );
    process.exit(0);
  }
  process.stderr.write("Unknown arguments. Run sift --help.\n");
  process.exit(2);
}

const program = Effect.scoped(
  Effect.gen(function* () {
    const config = yield* attempt(
      "CONFIG",
      "Could not load configuration.",
      () => loadConfig(),
    );
    if (!process.env.TYPESAFE_API_KEY)
      return yield* Effect.fail(
        failure("CONFIG", "TYPESAFE_API_KEY is required."),
      );
    const store = yield* Effect.acquireRelease(
      attempt("STORE", "Could not open artifact store.", async () => {
        const store = new ArtifactStore(config);
        await store.initialize();
        return store;
      }),
      (store) => Effect.promise(() => store.close()),
    );
    const app = createMcpServer(
      new SiftService(
        config,
        store,
        createJevProvider(process.env.TYPESAFE_API_KEY, config.model),
      ),
    );
    yield* Effect.acquireRelease(Effect.succeed(app), (app) =>
      Effect.promise(() => app.close()),
    );
    yield* Effect.async<void, SiftError>((resume) => {
      const done = () => resume(Effect.void);
      const failed = () =>
        resume(Effect.fail(failure("TRANSPORT", "MCP transport failed.")));
      app.server.server.onclose = done;
      app.server.server.onerror = failed;
      process.once("SIGINT", done);
      process.once("SIGTERM", done);
      process.stdin.once("end", done);
      app.server.connect(new StdioServerTransport()).catch(failed);
      return Effect.sync(() => {
        process.removeListener("SIGINT", done);
        process.removeListener("SIGTERM", done);
        process.stdin.removeListener("end", done);
      });
    });
  }),
);

Effect.runPromise(
  Effect.match(program, {
    onFailure: (error) => {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      process.exitCode = 1;
    },
    onSuccess: () => undefined,
  }),
).catch(() => {
  process.stderr.write("Sift stopped due to an internal failure.\n");
  process.exitCode = 1;
});
