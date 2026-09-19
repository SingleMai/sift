import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import type { CommandInput, Execution, OutputStream } from "./types.js";
import type { Config } from "./config.js";
import { failure } from "./errors.js";

/** POSIX process group is owned by this invocation, including shell children. */
export async function executeCommand(
  input: CommandInput,
  paths: Record<OutputStream, string>,
  config: Config,
  signal: AbortSignal,
): Promise<Execution> {
  if (process.platform !== "darwin" && process.platform !== "linux")
    throw failure("PLATFORM", "Only macOS and Linux are supported.");
  signal.throwIfAborted();
  const start = performance.now();
  const stdout = await open(paths.stdout, "w");
  let stderr;
  try {
    stderr = await open(paths.stderr, "w");
  } catch (error) {
    await stdout.close();
    throw error;
  }
  const handles = { stdout, stderr };
  const result: Execution = {
    status: "exited",
    exitCode: null,
    signal: null,
    bytes: { stdout: 0, stderr: 0 },
    truncated: false,
    durationMs: 0,
  };
  let child;
  try {
    child = spawn(input.executable, input.args, {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: commandEnvironment(),
    });
  } catch (error) {
    await Promise.all([stdout.close(), stderr.close()]);
    throw error;
  }
  let killed = false;
  let terminationError: unknown;
  const kill = () => {
    if (child.pid === undefined || killed) return;
    killed = true;
    // One hard termination: repeating signals while a POSIX group is being reaped can race.
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH")
        terminationError = error;
    }
  };
  const stop = (status: Execution["status"]) => {
    if (result.status === "exited") result.status = status;
    kill();
  };
  const cancel = () => stop("cancelled");
  const timer = setTimeout(() => stop("timeout"), config.commandTimeoutMs);
  signal.addEventListener("abort", cancel, { once: true });
  const closed = new Promise<void>((resolve) => {
    child.once("error", () => {
      result.status = "spawn_failed";
    });
    child.once("exit", (code, childSignal) => {
      result.exitCode = code;
      result.signal = childSignal;
      // Descendants must not outlive their owning command, even if the leader exits first.
      kill();
    });
    child.once("close", () => resolve());
  });
  let captureError: unknown;
  const capture = async (stream: OutputStream) => {
    try {
      for await (const data of child[stream]) {
        const buffer = Buffer.from(data as Buffer);
        const remaining = Math.max(
          0,
          config.outputBytes - result.bytes.stdout - result.bytes.stderr,
        );
        const keep = Math.min(buffer.length, remaining);
        result.bytes[stream] += keep;
        if (keep < buffer.length) {
          result.truncated = true;
          stop("output_limit");
        }
        let written = 0;
        while (written < keep) {
          const next = await handles[stream].write(
            buffer,
            written,
            keep - written,
          );
          if (!next.bytesWritten) throw new Error("Short write");
          written += next.bytesWritten;
        }
      }
    } catch (error) {
      // Destroying pipes after cancellation can reject an iterator; disk failures must still surface.
      if (
        result.status === "exited" ||
        (error as NodeJS.ErrnoException).code !== "ERR_STREAM_PREMATURE_CLOSE"
      )
        captureError = error;
      stop(result.status);
    }
  };
  try {
    if (signal.aborted) cancel();
    await Promise.all([capture("stdout"), capture("stderr"), closed]);
    kill();
    if (terminationError)
      throw failure(
        "TERMINATION",
        "Could not terminate the command process group.",
      );
    if (captureError)
      throw failure("CAPTURE", "Failed to capture command output.");
    result.durationMs = performance.now() - start;
    return result;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    kill();
    await Promise.all([handles.stdout.close(), handles.stderr.close()]);
  }
}

function commandEnvironment() {
  const env = { ...process.env };
  // Do not pass the judge's own credential to commands that may print their environment.
  delete env.TYPESAFE_API_KEY;
  return env;
}
