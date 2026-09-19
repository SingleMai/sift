# Sift

Command output, selected for your task.

Sift is a planned local MCP tool that runs a command, retains its original output, and selects evidence relevant to the calling model's stated purpose before returning it to context.

**Status: design and experiments. The MCP server and its tools are not implemented yet.**

## Planned behavior

- `execute`: run a finite, non-interactive command with an explicit working directory and query purpose.
- Store stdout and stderr locally; judge bounded source spans with neighboring context.
- Return original spans that meet a server-configured relevance threshold.
- `read_result`: retrieve bounded ranges of retained output when more context is needed.
- Distinguish command failure, incomplete judgment, filtered spans, and truncated output.

The chosen stack is Node.js, TypeScript, and Effect. The first judgment provider will be Jev, behind a replaceable interface. No API key is needed to run the local benchmarks.

Sift will inherit the host process's permissions; it is not a sandbox. The planned judgment integration sends selected command-output windows to the configured provider. Retention, limits, and disclosure belong in the implementation contract.

## Design and evidence

- [First-version design (Chinese)](docs/design.md)
- [Node / Effect / Rust comparison](benchmarks/local/RESULTS.md)
- [Reproduce the local experiment](benchmarks/local/README.md)

The experiment supports Node + Effect as a development-cost tradeoff, while showing a substantial memory advantage for the Rust prototype. It does not benchmark a complete MCP service or real model requests.

License terms have not yet been selected.
