# Live validation: 2026-09-19

These are exploratory measurements, not an independently labeled benchmark or threshold calibration. The 16 candidate fixtures were authored by the implementing assistant before inference. No private repository content or credentials are included in these snapshots.

## Provider availability

The first live request rejected the previously documented `jev-1.12` with HTTP 400 (unknown model). The account model-list API returned `jev-latest` and `jev-preview`. Sift now requests `jev-latest` by default, without fallback. This moving alias can change; record the requested model and rerun evaluations when behavior changes.

## Candidate pilot

[Fixtures](cases.json) cover positive evidence, irrelevant banners, query-dependent relevance, neighboring evidence, Chinese text, and an instruction embedded in output. [Recorded results](results/2026-09-19-candidates.json) contain probabilities and usage.

| Inclusive threshold | True positives | False positives | False negatives | True negatives |
| ------------------- | -------------: | --------------: | --------------: | -------------: |
| 0.5–0.8             |              8 |               0 |               0 |              8 |
| 0.9                 |              7 |               0 |               1 |              8 |
| 0.95                |              4 |               0 |               4 |              8 |

The stack-location evidence scored 0.85 and was lost at 0.9. This tiny synthetic set cannot establish real-world accuracy. Usage was 8,991 input and 352 output tokens.

## Production stdio MCP

The [synthetic MCP run](results/2026-09-19-mcp.json) launched the built CLI, executed a command, judged two 256-byte windows, returned the relevant window, and recovered the exact 512-byte original via `read_result`. Scores were 0.24 and 0.92 with threshold 0.8. Total elapsed time was 2,584 ms, including a 23 ms command; usage was 1,308 input and 44 output tokens.

The [repository run](results/2026-09-19-repository.json) executed Sift's public contract tests and judged their real TAP output. At that revision, 24 tests actually ran and all passed. With 1,024-byte target windows, 2,048-byte neighboring context and threshold 0.8, 4 of 6 windows were retained: 3,457 of 5,369 original bytes (36% source-text reduction). The test/pass/fail summary survived, and backread exactly matched the retained original artifact.

The summary window scored **exactly 0.8**: a higher cutoff would have removed crucial evidence. Total time was 5,929 ms, including a 2,357 ms command, approximately 3,571 ms extra for judgment and the surrounding pipeline. Usage was 10,072 input and 132 output tokens. Overlapping context is repeated across calls; source-text reduction is not provider-token or cost reduction.

These snapshots measure retained original bytes, not complete serialized MCP responses or total task context. The verification deliberately reads all raw output back, so the complete verification conversation does not demonstrate context savings. Future script runs also record serialized execute and verification-read response sizes. No broad latency distribution or production quality claim follows from these single runs.

## Reproduce (opt-in, billable)

Provide `TYPESAFE_API_KEY` through your environment or secret manager. Never commit it. Ordinary `npm run check` is offline with mocked judgments.

```sh
npm run smoke:live
npm run eval:live
npm run smoke:mcp:live
npm run smoke:repository:live
npm run eval:tasks:live
```

Reports are written under ignored `.tmp/`. The repository smoke sends this repository's test output to TypeSafe. The other commands use public synthetic text. Model selection follows Sift's default; threshold 0.8 and smaller test windows are explicit experimental settings, not a recommended global policy. Error-path contract tests added after the repository snapshot increase the suite count without altering the recorded historical result.

Next quality work should use independently labeled, varied command outputs and held-out tasks, measure lost decisive evidence and full response overhead, and compare actual caller outcomes and latency against unfiltered output. Keep threshold configuration explicit until those tradeoffs are measured.

## Task-level comparison: failures exposed

[Task definitions](tasks.json) fix expected decisive evidence before inference. The commands run a deliberately failing real Node test, real ripgrep over public fixture settings, and synthetic JSON whose timeout scalar crosses a 1 KiB boundary, with an important warning on stderr. These are authored development tasks, not organic user tasks or independently labeled data. [Recorded results](results/2026-09-19-tasks.json) include all six executions, including failures.

| Task                         | Target bytes | All required evidence retained   | Tool-result byte change vs baseline | Added time |
| ---------------------------- | -----------: | -------------------------------- | ----------------------------------: | ---------: |
| Failing tests                |        1,024 | **No: failure count lost**       |                       22.3% smaller |     5.43 s |
| Search settings              |        1,024 | Yes                              |                       75.3% smaller |     3.23 s |
| Cross-boundary JSON + stderr |        1,024 | Yes                              |                        50.0% larger |     0.72 s |
| Failing tests                |        8,192 | Yes                              |                        15.5% larger |     4.26 s |
| Search settings              |        8,192 | **No: only relevant match lost** |                       89.8% smaller |     1.09 s |
| Cross-boundary JSON + stderr |        8,192 | Yes                              |                        50.0% larger |     1.34 s |

All runs use threshold 0.8 and 2,048 bytes of neighboring context. Each configuration ran once; command durations and test-runner text timing differ slightly. Configuration order was not randomized. Total usage: 18 judgments, 30,077 input and 396 output tokens. These timings do not isolate network variability or model warm-up.

The 1 KiB test-summary target scored 0.15 despite containing `# fail 1`; the 8 KiB search target scored 0.79 despite containing the required settings. The misleading 89.8% reduction is therefore a **quality failure**, not a success. Four of six runs retained all predeclared markers; retaining those markers does not prove the caller can complete the task correctly. No caller model or tokenizer was evaluated.

The baseline is explicitly constructed as an unfiltered MCP tool-result object with one JSON text item containing `execution`, `stdout`, and `stderr`, plus `isError: false`. Both measured sides include tool-result metadata and JSON escaping, but exclude JSON-RPC envelopes and transport framing. This is a reproducible byte comparison, not a claim about any particular client's token usage. Correctness verification reads local artifacts, not a second MCP response.

The scorer validates returned byte ranges against the original streams and checks continuous coverage of each required marker. It cannot count concatenated fragments across an omitted gap or confuse stdout with stderr. Missing or duplicate fixture markers fail the harness rather than silently being counted as model misses. Two offline tests protect these measurement contracts.

`eval:tasks:live` requires `rg` on PATH, writes the report even for measured quality failures, and exits nonzero for missing required evidence, incomplete judgment or response truncation. Deliberate test-command exit code 1 is expected and is not itself a harness failure. This billable quality experiment is separate from offline CI. Future runs retain exact inputs and responses privately under ignored `.tmp/task-evaluation-artifacts/` for diagnosis; the first recorded run predates that retention addition. The published report omits credentials, local paths and result IDs.

The evidence does **not** support changing the universal cutoff or choosing one global chunk size. The next implementation experiment should compare format-aware TAP records and search-result records through the existing `ChunkStrategy` interface, using these failures as development regressions plus fresh held-out tasks. Merely lowering the cutoff until these cases pass would overfit the pilot. Small outputs also need an explicit product decision about whether filtering overhead is worthwhile; this evaluation does not introduce an automatic bypass or return below-threshold content.

## Structured strategy comparison

The next implementation adds opt-in `chunkStrategy: "command"`; default `window` and threshold policy remain unchanged. TAP separates its final summary and packs fitting test records; explicit line-number search output uses bounded line groups. Neither adapter decides semantic relevance. [Implementation](../src/strategies.ts) and [configuration](../docs/configuration.md#experimental-command-aware-chunking) specify supported shapes and limits.

We reran the three original tasks and added two tasks with expectations fixed before their first inference: two independent failing assertions, and two client settings including disabled retries. These new tasks are assistant-authored and use the same formats; they are fresh development checks, not independently curated held-out evaluation. [Full results](results/2026-09-19-strategies.json) preserve both baseline and structured runs.

| Task                         | Window: response change | Command strategy: response change | Command strategy: calls | Command strategy: added time |
| ---------------------------- | ----------------------: | --------------------------------: | ----------------------: | ---------------------------: |
| Failing tests                |            17.5% larger |                     49.5% smaller |                       6 |                       3.56 s |
| Search settings              |             8.8% larger |                     74.3% smaller |                       7 |                       1.20 s |
| Cross-boundary JSON + stderr |            55.6% larger |                      55.6% larger |                       2 |                       0.65 s |
| Two failures (new)           |            19.7% larger |                     17.8% smaller |                       6 |                       1.30 s |
| Two settings (new)           |            20.1% larger |                     12.1% smaller |                       3 |                       2.03 s |

All ten executions retained their predeclared markers. **The generic baseline passed this rerun too:** its unchanged search input scored 0.90 versus the earlier 0.79. This variability means the first failures cannot be declared permanently fixed, and single-run comparisons do not establish a recall advantage. The separated TAP summaries scored 0.93 and 0.89 in this run. The cross-boundary JSON command is intentionally outside recognized formats and still uses the generic strategy.

Both modes use configured chunkBytes 8,192, contextBytes 2,048 and threshold 0.8. Structured adapters cap actual targets at 1,024 bytes; this compares the whole strategy choice, not record boundaries in isolation. Prompt and cutoff were not tuned. The generic mode used 6 requests and 9,604 input tokens; command mode used 24 requests and 40,348 input tokens. Output tokens were 132 and 528 respectively. The reduction in caller response bytes therefore comes with substantially more judge work. The byte baseline is the same explicit unfiltered tool-result definition above. No task-model outcome, monetary cost, or token savings for the caller was measured.

```sh
npm run eval:tasks:live -- --compare-strategies
```

Offline tests protect exact byte coverage, UTF-8/CRLF/long-line handling, fitting record boundaries, summary separation, conservative routing, and explicit unprocessed ranges when structured chunks exhaust the call budget. Inference quality remains opt-in and billable. The stored report has `qualityPassed: true` for this run only. Earlier failing reports remain committed. Wider formats, repeated runs and independent task labels are still needed before considering this the default.
