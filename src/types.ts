export const streams = ["stdout", "stderr"] as const;
export type OutputStream = (typeof streams)[number];
export interface CommandInput {
  executable: string;
  args: string[];
  cwd: string;
  purpose: string;
}
export interface Position {
  line: number;
  byteColumn: number;
}
export interface Span {
  stream: OutputStream;
  start: number;
  end: number;
  from: Position;
  to: Position;
}
export type Decision =
  | { status: "judged"; probability: number }
  | {
      status: "failed";
      reason:
        | "provider"
        | "invalid_response"
        | "timeout"
        | "invalid_utf8"
        | "configuration"
        | "authentication"
        | "rate_limit";
    }
  | { status: "unprocessed"; reason: "budget" | "deadline" | "cancelled" };
export type ChunkRecord = Span & { decision: Decision };
export interface Execution {
  status: "exited" | "timeout" | "cancelled" | "output_limit" | "spawn_failed";
  exitCode: number | null;
  signal: string | null;
  bytes: Record<OutputStream, number>;
  truncated: boolean;
  durationMs: number;
}
export interface Manifest {
  version: 1;
  id: string;
  createdAt: number;
  expiresAt: number;
  state: "running" | "complete" | "failed";
  execution?: Execution;
  records: ChunkRecord[];
  invalidStreams: OutputStream[];
  threshold: number;
  provider: string;
  model: string;
  policyVersion: "relevance-v1";
  settings: {
    chunkBytes: number;
    contextBytes: number;
    maxJudgments: number;
    judgmentBytes: number;
  };
  inputBytes: number;
  requests: number;
  usage: { inputTokens: number; outputTokens: number };
}
