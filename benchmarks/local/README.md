# Local pipeline benchmark

This is a synthetic experiment, not the Sift implementation. It makes no network or model calls during benchmark execution; installing dependencies requires network access unless cached.

The Rust memory conversion and filesystem adapter currently target **macOS**. Use Node 24 and a recent stable Rust toolchain. A full run writes several GiB across repeated temporary captures; captures are removed after successful cases. Failed/interrupted runs may leave captures for manual cleanup.

```sh
cd benchmarks/local
npm ci
npm run build:rust
npm run bench
```

The runner rotates Node, Node + Effect, and Rust over five repetitions per scenario. It writes `comparison-results.latest.json`, preserving the committed historical `comparison-results.json`. It prints summaries and checks equality of chunk counts, line counts, request bytes, and selected bytes across implementations.

The pipeline captures a common Node producer's stdout, indexes bounded chunks, serializes contextual requests, computes a SHA-256 mock judgment, validates its numeric result, and reads approximately 20% of source bytes back. It does not exercise MCP transport, real model latency, tokenizer costs, cancellation, or semantic quality.

`compare-node.mjs` is the JavaScript consumer; `bench.mjs` provides the identical producer for Rust. `rust/src/main.rs` uses a current-thread Tokio runtime and filesystem blocking workers. Both variants apply a byte cap even to a single huge line.

The UTF-8 context windows and intra-line source mapping are experimental. Coverage checks do not prove that semantic evidence survives filtering. Do not reuse the prototype as a production chunker without dedicated correctness tests.

See [recorded results and limitations](RESULTS.md).
