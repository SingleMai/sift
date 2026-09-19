# Try Sift 0.1.0-alpha.1

This first preview is for supervised use in real development workflows. It is distributed as a built npm tarball on [GitHub Releases](https://github.com/SingleMai/sift/releases/tag/v0.1.0-alpha.1), not on the npm registry. Node.js 24+ and macOS or Linux are required. Commands such as `rg` must be available on the server's PATH. License remains `UNLICENSED`; this preview does not add an open-source license grant.

## Install the pinned artifact

```sh
npm install --prefix "$HOME/.local/share/sift-preview-runtime" --omit=dev --ignore-scripts \
  https://github.com/SingleMai/sift/releases/download/v0.1.0-alpha.1/sift-mcp-0.1.0-alpha.1.tgz
"$HOME/.local/share/sift-preview-runtime/node_modules/.bin/sift" --version
```

Expected version: `0.1.0-alpha.1`. No source checkout, TypeScript compiler or build step is required. The tarball includes an npm shrinkwrap to lock transitive dependencies. Installation still needs network access to fetch those dependencies. A `SHA256SUMS` asset accompanies the tarball; after downloading both, verify using `shasum -a 256 -c SHA256SUMS` on macOS or `sha256sum -c SHA256SUMS` on Linux.

## Connect an MCP client

Create a configuration file, for example `/absolute/path/sift.config.json`:

```json
{
  "threshold": 0.8,
  "chunkStrategy": "command",
  "stateDir": "/absolute/path/sift-preview-artifacts"
}
```

These are explicit trial choices: 0.8 is not calibrated, and `command` is an opt-in strategy. Choose `window` to compare generic grouping. Use a separate state directory for each simultaneously running server. Configured paths must be absolute; JSON paths do not expand `~` or environment variables.

Add this entry using your client's MCP configuration or UI, substituting real absolute paths and supplying the key via its secret/environment mechanism:

```json
{
  "mcpServers": {
    "sift": {
      "command": "/absolute/path/to/node",
      "args": [
        "/absolute/path/to/.local/share/sift-preview-runtime/node_modules/sift-mcp/dist/cli.js"
      ],
      "env": {
        "TYPESAFE_API_KEY": "<provided by your secret mechanism>",
        "SIFT_CONFIG": "/absolute/path/sift.config.json"
      }
    }
  }
}
```

Use `node -p process.execPath` to find your Node.js 24+ executable. Restart or reconnect the MCP server in the client after configuration changes. The handshake should identify Sift `0.1.0-alpha.1` and expose `execute` and `read_result`. Do not put the API key in command arguments, source control or an issue report. No client configuration is changed by installation.

## First real trial

Give the calling agent this guidance:

> Use Sift for potentially large, finite, read-oriented command output. Supply the concrete question in `purpose`. Check command exit status, truncation, judgment completeness and returned evidence before drawing conclusions. Missing evidence does not prove absence; use `read_result` to recover decisive omitted ranges. Use ordinary tools for writes, interactive processes and binary output. Sift does not enforce a read-only command policy.

For example, ask it to run:

```json
{
  "executable": "rg",
  "args": ["--line-number", "retry", "src"],
  "cwd": "/absolute/path/to/your/project",
  "purpose": "Find configured retry limits, including disabled retries and exceptions."
}
```

Inspect the `execution`, `judgment`, `judgment.strategies`, `output_truncated` and `evidence` fields. Recover original output with `read_result`, passing the returned `result_id`, `stream`, `offset` and `limit`. Follow `next_offset` while `eof` is false. If a model filter appears to have omitted a decisive fact, read the original before accepting a conclusion. Expected raw results expire after 24 hours; physical cleanup occurs lazily.

## Known limits and useful feedback

- Filtering is probabilistic. Earlier trials lost decisive evidence, and identical search input later crossed the threshold. `judgment.complete` means processing coverage, not correctness.
- Structured TAP/search trials reduced complete response bytes on some tasks, but used about four times the judge input tokens. Small outputs grew. No end-to-end task-token saving is established.
- Only narrow direct Node TAP and line-number ripgrep command forms have adapters. Other formats, wrappers and stderr use generic windows. See [configuration](configuration.md).
- Sift runs with the host user's permissions, has no sandbox or semantic admission filter, and sends command-output windows to TypeSafe. Use it only where that data flow is appropriate for the project. The judge key is excluded from executed commands' environment; other host environment variables are inherited.
- One process owns each state directory. After a hard crash, verify that the PID recorded in `.lock` is no longer running before removing that stale lock. Never remove an active owner's lock.

For a useful report, include the version, OS/Node versions, requested model, strategy, threshold, relevant source ranges, failed/missing evidence, judgment usage and elapsed time. Results and manifests remain in your local state directory. Share only sanitized examples; do not attach raw proprietary output or credentials automatically. There is no background telemetry or automatic upload of stored artifacts.

## Disable, reset or update

Disable/remove the MCP entry and stop its server to return to your ordinary command tool. To remove this installation:

```sh
npm uninstall --prefix "$HOME/.local/share/sift-preview-runtime" sift-mcp
```

Artifacts are independent of the installation and are not deleted by uninstall. After the server stops, you may explicitly remove its dedicated artifact directory if you no longer need the originals. To try a later preview, stop the server, install that release's pinned tarball into the same prefix, and reconnect; reinstall an earlier pinned tarball to roll back. Keep this configuration separate from other environments while trialing.
