# Rust / Node / Effect local comparison

2026-09-19. Apple M5 Pro, macOS arm64, 24 GiB RAM. Node v24.18.0, Effect 3.22.2, rustc 1.98.0. Rust built with cargo build --release; dependency versions recorded in rust/Cargo.lock. Initial optimized build took 13.26 seconds including dependencies/cache state; this is one observation, not a compilation benchmark. No compilation time included below.

Five repetitions per implementation per scenario, fresh worker processes, rotating execution order. Every implementation uses the same Node child producer with identical synthetic bytes. Command-level concurrency is 1 or 4; per-command request preparation concurrency is 4. Rust uses Tokio current_thread for application logic and blocking workers for file I/O; Node uses its event loop and filesystem workers. No parallel CPU worker pool was added to Rust. The Node comparator caches the hard-cap environment setting instead of re-reading it for every line.

Pipeline: child stdout to file, newline/byte index, approximately 8 KiB chunks with 2 KiB context each side, request JSON serialization, SHA-256 mock judgment, response JSON roundtrip and numeric validation, read/hash every fifth original chunk, then delete temporary capture. All variants use the byte hard-cap. There is no model/network request or full MCP service.

| Workload | Node ms | Node RSS MiB | Effect ms | Effect RSS MiB | Rust ms | Rust RSS MiB |
|---|---:|---:|---:|---:|---:|---:|
| 1 MiB × 1 | 36.1 | 55.2 | 41.2 | 96.1 | 30.5 | 2.6 |
| 10 MiB × 1 | 92.6 | 70.5 | 103.6 | 121.7 | 83.8 | 2.7 |
| 100 MiB × 1 | 620.1 | 102.0 | 668.2 | 216.6 | 581.7 | 3.0 |
| 10 MiB × 4 | 266.7 | 93.9 | 286.3 | 148.8 | 222.9 | 3.8 |
| 100 MiB × 4 | 2248.1 | 149.9 | 2378.0 | 244.1 | 1967.9 | 5.6 |
| 100 MiB × 1 (single line) | 516.0 | 101.9 | 564.7 | 217.0 | 546.6 | 3.0 |

Values are medians of five samples. RSS is each processing process's lifetime maximum, excludes producer child and filesystem cache; it includes interpreter/framework initialization. Rust obtains RUSAGE_SELF directly (macOS bytes); Node resourceUsage().maxRSS is KiB. These are not total process-tree memory figures. The shared Node producer adds its own memory to every implementation. A complete Rust MCP/HTTP client will consume more memory than this small benchmark binary.

Wall timing starts after imports/runtime setup, and includes producer startup, capture, processing and deletion. It excludes compilation, model latency and full MCP initialization. Filesystem caches are warm; no fsync, durable-storage or cold-disk benchmark. The OS/file APIs and SHA/JSON implementations necessarily differ. This is a comparison of two equivalent prototypes, not an upper bound for either language.

Each case verifies gap-free byte coverage and exact processed count. Harness also asserts equality across implementations of chunk count, line count, serialized request byte count and selected byte count. It does not prove identical semantic decisions or production-quality UTF-8 context handling. Selection is deterministic by index, approximately 20%, rather than by simulated scores.

An initial single-line run exposed a carry-boundary defect in the prototype hard-cap: it attempted to inspect a position in the previous read buffer. Rust stopped on out-of-bounds access; JavaScript's negative Buffer property yielded undefined. Both comparator implementations were corrected to select a cut within the current buffer, and the full suite was rerun. Arbitrary UTF-8 inputs and exact line/column recovery still need dedicated contract tests before production.

Limitations: repeated synthetic logs and one ASCII single-line fixture only; no realistic large JSON parsing/tokenization, runtime Schema validation, cancellation comparison, SDK integration or semantic quality evaluation. Earlier direct-child cancellation measurements apply only to Node, not Rust. Shared workstation, not isolated benchmark hardware. Native/Effect/Rust baseline memory stacks differ, as they would in deployment, but no MCP SDK is loaded in these prototypes.

Conclusion: Rust offers a substantial processing-process memory reduction here; end-to-end local pipeline latency differences are much smaller because file operations, task scheduling and producer startup are part of the workload. Results justify a workload-dependent choice, not a claim that Node is as fast or as memory-efficient as Rust.

Artifacts: compare.mjs (rotating harness), compare-node.mjs, rust/src/main.rs, comparison-results.json (90 historical raw samples). Follow README.md to install dependencies and build the Rust binary, then run node compare.mjs. New runs write comparison-results.latest.json and print summaries and workload equality checks; historical results remain unchanged. Earlier Node-only exploratory runs are not included in this repository.
