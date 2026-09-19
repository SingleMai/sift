import { Data, Effect } from "effect";

export class SiftError extends Data.TaggedError("SiftError")<{
  code: string;
  message: string;
  resultId?: string;
}> {}

export const failure = (code: string, message: string, resultId?: string) =>
  new SiftError({ code, message, ...(resultId ? { resultId } : {}) });
export function attempt<A>(
  code: string,
  message: string,
  run: (signal: AbortSignal) => Promise<A>,
) {
  return Effect.tryPromise({
    try: run,
    catch: (error) =>
      error instanceof SiftError ? error : failure(code, message),
  });
}
