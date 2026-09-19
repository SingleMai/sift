import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import type { Manifest, OutputStream } from "./types.js";
import { failure } from "./errors.js";

const idPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const metadataAllowance = 8 * 1024 * 1024;

/** One owner per state directory; leases protect reads from expiry cleanup. */
export class ArtifactStore {
  private leases = new Map<string, number>();
  private locked = false;
  constructor(
    readonly config: Config,
    private readonly now: () => number = Date.now,
  ) {}

  async initialize() {
    await mkdir(this.config.stateDir, { recursive: true, mode: 0o700 });
    if (!(await lstat(this.config.stateDir)).isDirectory())
      throw failure("STORE", "State directory must be a real directory.");
    await chmod(this.config.stateDir, 0o700);
    let lock;
    try {
      lock = await open(join(this.config.stateDir, ".lock"), "wx", 0o600);
    } catch {
      throw failure(
        "STORE_LOCKED",
        "State directory is locked. Stop its owner before removing a stale .lock file.",
      );
    }
    this.locked = true;
    try {
      await lock.writeFile(String(process.pid));
    } finally {
      await lock.close();
    }
    try {
      await this.cleanup();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close() {
    if (this.leases.size)
      throw failure(
        "STORE_BUSY",
        "Cannot close store while results are in use.",
      );
    if (this.locked) {
      await rm(join(this.config.stateDir, ".lock"));
      this.locked = false;
    }
  }

  directory(id: string) {
    if (!idPattern.test(id)) throw failure("RESULT_ID", "Invalid result ID.");
    return join(this.config.stateDir, id);
  }
  path(id: string, stream: OutputStream) {
    return join(this.directory(id), stream);
  }
  async save(manifest: Manifest) {
    const text = JSON.stringify(manifest);
    if (Buffer.byteLength(text) > metadataAllowance / 2)
      throw failure(
        "METADATA_LIMIT",
        "Result metadata exceeds its reserved budget.",
      );
    const directory = this.directory(manifest.id);
    await writeFile(join(directory, "manifest.tmp"), text, { mode: 0o600 });
    await rename(
      join(directory, "manifest.tmp"),
      join(directory, "manifest.json"),
    );
  }
  private async load(id: string): Promise<Manifest> {
    try {
      const file = join(this.directory(id), "manifest.json");
      if ((await stat(file)).size > metadataAllowance / 2)
        throw failure("STORE", "Result metadata is oversized.");
      const manifest = JSON.parse(await readFile(file, "utf8")) as Manifest;
      if (
        manifest.version !== 1 ||
        manifest.id !== id ||
        !Number.isFinite(manifest.expiresAt) ||
        !Array.isArray(manifest.records)
      )
        throw failure("STORE", "Invalid result metadata.");
      return manifest;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw failure("RESULT_MISSING", "Result is missing or has expired.");
      throw error;
    }
  }

  async lease<A>(
    id: string,
    fn: (manifest: Manifest) => Promise<A>,
  ): Promise<A> {
    this.directory(id);
    this.leases.set(id, (this.leases.get(id) ?? 0) + 1);
    try {
      const manifest = await this.load(id);
      if (manifest.expiresAt <= this.now())
        throw failure("RESULT_EXPIRED", "Result has expired.");
      if (manifest.state === "running")
        throw failure("RESULT_RUNNING", "Result is not ready for reading.");
      return await fn(manifest);
    } finally {
      const count = this.leases.get(id)! - 1;
      if (count) this.leases.set(id, count);
      else this.leases.delete(id);
    }
  }

  async cleanup() {
    for (const entry of await readdir(this.config.stateDir, {
      withFileTypes: true,
    })) {
      if (!idPattern.test(entry.name)) continue;
      if (!entry.isDirectory())
        throw failure("STORE", "Unexpected artifact entry.");
      if (this.leases.has(entry.name)) continue;
      const manifest = await this.load(entry.name);
      if (manifest.expiresAt <= this.now())
        await rm(this.directory(entry.name), { recursive: true });
    }
  }

  async create(provider: string): Promise<Manifest> {
    if (!this.locked) throw failure("STORE", "Store is not initialized.");
    await this.cleanup();
    let used = 0,
      count = 0;
    for (const entry of await readdir(this.config.stateDir, {
      withFileTypes: true,
    })) {
      if (!idPattern.test(entry.name)) continue;
      count++;
      for (const file of await readdir(this.directory(entry.name)))
        used += (await lstat(join(this.directory(entry.name), file))).size;
    }
    if (
      count >= this.config.maxResults ||
      used + this.config.outputBytes + metadataAllowance >
        this.config.storageBytes
    )
      throw failure(
        "STORE_FULL",
        "Artifact capacity reached; wait for expiry or clear old results while Sift is stopped.",
      );
    const id = randomUUID(),
      createdAt = this.now();
    const manifest: Manifest = {
      version: 1,
      id,
      createdAt,
      expiresAt: createdAt + this.config.retentionMs,
      state: "running",
      records: [],
      invalidStreams: [],
      threshold: this.config.threshold,
      provider,
      model: this.config.model,
      policyVersion: "relevance-v1",
      settings: {
        chunkBytes: this.config.chunkBytes,
        contextBytes: this.config.contextBytes,
        maxJudgments: this.config.maxJudgments,
        judgmentBytes: this.config.judgmentBytes,
      },
      inputBytes: 0,
      requests: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    };
    await mkdir(this.directory(id), { mode: 0o700 });
    this.leases.set(id, 1);
    try {
      await this.save(manifest);
      for (const stream of ["stdout", "stderr"] as const)
        await writeFile(this.path(id, stream), "", { mode: 0o600, flag: "wx" });
      return manifest;
    } catch (error) {
      this.leases.delete(id);
      await rm(this.directory(id), { recursive: true });
      throw error;
    }
  }
  releaseExecution(id: string) {
    this.leases.delete(id);
  }
}
