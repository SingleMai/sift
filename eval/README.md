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
```

Reports are written under ignored `.tmp/`. The repository smoke sends this repository's test output to TypeSafe. The other commands use public synthetic text. Model selection follows Sift's default; threshold 0.8 and smaller test windows are explicit experimental settings, not a recommended global policy. Error-path contract tests added after the repository snapshot increase the suite count without altering the recorded historical result.

Next quality work should use independently labeled, varied command outputs and held-out tasks, measure lost decisive evidence and full response overhead, and compare actual caller outcomes and latency against unfiltered output. Keep threshold configuration explicit until those tradeoffs are measured.
