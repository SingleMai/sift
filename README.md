# Sift

Command output, selected for your task.

Sift is a local MCP tool that runs a command, retains its original output, and selects evidence relevant to the calling model's stated purpose before returning it to context.

**Status: experimental first implementation.** The command pipeline, stdio MCP tools, Jev adapter, and deterministic contract tests are implemented. Task-level live trials have exposed lost decisive evidence at both tested chunk sizes; this is not yet validated for unattended evidence filtering. See the [recorded failures and full-response measurements](eval/README.md#task-level-comparison-failures-exposed). Threshold calibration remains incomplete.

## Behavior

- `execute`: run a finite, non-interactive command with an explicit working directory and query purpose.
- Store stdout and stderr locally; judge bounded source spans with neighboring context.
- Return original spans that meet a server-configured relevance threshold.
- `read_result`: retrieve bounded ranges of retained output when more context is needed.
- Distinguish command failure, incomplete judgment, filtered spans, and truncated output.

The stack is Node.js 24+, TypeScript, and Effect, initially supporting macOS/Linux. Jev is behind a replaceable judgment interface; command-specific chunk strategies have a separate extension interface. No API key is needed to run tests or local benchmarks.

Sift inherits the host process's permissions; it is not a sandbox. Judgment sends command-output windows to TypeSafe. Commands are never retried. Errors, incomplete processing, and filtered content are reported separately.

## Start

```sh
npm ci
npm run check
```

Configure your MCP client to launch `node /absolute/path/to/sift/dist/cli.js`, with `TYPESAFE_API_KEY` and an explicit `SIFT_THRESHOLD`. There is no silently chosen relevance threshold. See [configuration and tool contracts](docs/configuration.md) for an example, resource limits, original-output backread, and cancellation behavior.

`npm run smoke:live` is a separate, opt-in billable integration check using synthetic public text; ordinary tests never call the model.

## Design and evidence

- [Live Jev and MCP validation, including limitations](eval/README.md)
- [First-version design (Chinese)](docs/design.md)
- [Node / Effect / Rust comparison](benchmarks/local/RESULTS.md)
- [Reproduce the local experiment](benchmarks/local/README.md)

The experiment supports Node + Effect as a development-cost tradeoff, while showing a substantial memory advantage for the Rust prototype. It does not benchmark a complete MCP service or real model requests.

License terms have not yet been selected.
