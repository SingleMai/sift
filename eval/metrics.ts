export interface Evidence {
  stream: "stdout" | "stderr";
  start: number;
  end: number;
  text: string;
}
export interface RequiredEvidence {
  stream: "stdout" | "stderr";
  text: string;
}

/** Score source coverage, never concatenate fragments across omitted bytes. */
export function scoreEvidence(
  sources: Record<"stdout" | "stderr", string>,
  evidence: readonly Evidence[],
  required: readonly RequiredEvidence[],
) {
  for (const span of evidence) {
    const source = Buffer.from(sources[span.stream]);
    if (
      span.start < 0 ||
      span.end > source.length ||
      span.end <= span.start ||
      !source.subarray(span.start, span.end).equals(Buffer.from(span.text))
    )
      throw new Error("Returned evidence does not match original byte range");
  }
  return required.map((item) => {
    const source = Buffer.from(sources[item.stream]),
      needle = Buffer.from(item.text);
    const start = source.indexOf(needle);
    if (!needle.length || start < 0 || source.indexOf(needle, start + 1) >= 0)
      throw new Error(
        "Expected evidence must occur exactly once in captured source",
      );
    const end = start + needle.length;
    let covered = start;
    for (const span of evidence
      .filter((span) => span.stream === item.stream)
      .sort((a, b) => a.start - b.start)) {
      if (span.start <= covered && span.end > covered) covered = span.end;
    }
    return { ...item, start, end, retained: covered >= end };
  });
}

/** Compare tool-result objects; excludes JSON-RPC envelopes and transport framing. */
export function responseSizes(
  result: unknown,
  execution: unknown,
  sources: Record<"stdout" | "stderr", string>,
) {
  const baseline = {
    content: [
      { type: "text", text: JSON.stringify({ execution, ...sources }) },
    ],
    isError: false,
  };
  const filteredBytes = Buffer.byteLength(JSON.stringify(result));
  const unfilteredBytes = Buffer.byteLength(JSON.stringify(baseline));
  return {
    filteredBytes,
    unfilteredBytes,
    reduction: 1 - filteredBytes / unfilteredBytes,
  };
}
