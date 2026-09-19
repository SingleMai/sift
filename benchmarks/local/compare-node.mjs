import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Writable } from 'node:stream';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const root = import.meta.dirname;
const useEffect = process.env.BENCH_EFFECT === '1';
const hardCap = process.env.BENCH_HARD_CAP === '1';
const Effect = useEffect && process.argv[2] !== 'produce' ? (await import('effect')).Effect : null;
const MiB = 1024 * 1024;
const sizes = [1, 10, 100];
const line = Buffer.from('2026-09-19T10:00:00Z INFO request=123456 path=/api/query 中文日志 task completed duration=123ms status=200 payload=abcdefghijklmnopqrstuvwxyz0123456789\n');
const block = process.env.BENCH_LONG_LINE === '1' ? Buffer.alloc(65536, 97) : Buffer.concat(Array.from({length: Math.ceil(65536 / line.length)}, () => line));

if (process.argv[2] === 'produce') {
  let left = Number(process.argv[3]);
  for await (const _ of Readable.from((async function* () {
    while (left > 0) { const b = block.subarray(0, Math.min(left, block.length)); left -= b.length; yield b; }
  })())) {
    if (!process.stdout.write(_)) await new Promise(r => process.stdout.once('drain', r));
  }
  process.exit(0);
}

async function one(size, id, kind) {
  const path = `${root}/capture-${id}.txt`;
  const chunks = [];
  let bytes = 0, start = 0, lines = 0, lastLine = 0;
  const t0 = performance.now();
  const child = spawn(process.execPath, [import.meta.filename, 'produce', String(size * MiB)], {stdio: ['ignore', 'pipe', 'pipe']});
  const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`exit ${code}`))); });
  await pipeline(child.stdout, fs.createWriteStream(path));
  await exited;
  const captureMs = performance.now() - t0;
  const t1 = performance.now();
  for await (const b of fs.createReadStream(path, {highWaterMark: 65536})) {
    function capUntil(end) {
      if (!hardCap) return;
      while (end - start > 16384) {
        let cut = Math.max(start + 8192, bytes);
        while (cut < end && (b[cut - bytes] & 0xc0) === 0x80) cut++;
        chunks.push({start, end:cut}); start = cut;
      }
    }
    let at = -1;
    while ((at = b.indexOf(10, at + 1)) !== -1) {
      lines++;
      const end = bytes + at + 1;
      capUntil(end);
      if (end - start >= 8192) { chunks.push({start, end, first: lastLine + 1, last: lines}); start = end; lastLine = lines; }
    }
    capUntil(bytes + b.length);
    bytes += b.length;
  }
  if (start < bytes) chunks.push({start, end: bytes, first: lastLine + 1, last: lines + 1});
  // Independent coverage invariant: no gaps, overlaps, or missing tail.
  let end = 0;
  for (const c of chunks) { if (c.start !== end || c.end <= c.start) throw Error('coverage'); end = c.end; }
  if (end !== size * MiB) throw Error('size');
  const indexMs = performance.now() - t1;
  const handle = await fsp.open(path, 'r');
  let cursor = 0, processed = 0, wireBytes = 0, acceptedBytes = 0;
  const t2 = performance.now();
  async function processChunk(n) {
      const c = chunks[n];
      const lo = Math.max(0, c.start - 2048), hi = Math.min(bytes, c.end + 2048);
      const buf = Buffer.allocUnsafe(hi - lo);
      await handle.read(buf, 0, buf.length, lo);
      const payload = JSON.stringify({purpose:'定位请求失败的证据与反证', command:'synthetic-output', start:c.start, end:c.end, context:buf.toString('utf8')});
      // Exercise encoding and deterministic response validation, not model latency.
      const score = createHash('sha256').update(payload).digest()[0] / 255;
      const response = JSON.parse(JSON.stringify({relevance: score}));
      if (!Number.isFinite(response.relevance) || response.relevance < 0 || response.relevance > 1) throw Error('invalid score');
      wireBytes += Buffer.byteLength(payload);
      if (n % 5 === 0) acceptedBytes += c.end - c.start;
      processed++;
  }
  if (Effect) {
    await Effect.runPromise(Effect.forEach(chunks, (_,n) => Effect.tryPromise(() => processChunk(n)), {concurrency:4, discard:true}));
  } else {
    await Promise.all(Array.from({length:4}, async () => {
      while(cursor < chunks.length) await processChunk(cursor++);
    }));
  }
  await handle.close();
  const judgePrepMs = performance.now() - t2;
  if (processed !== chunks.length) throw Error('not processed');
  const t3 = performance.now();
  const reader = await fsp.open(path, 'r');
  for (let i = 0; i < chunks.length; i += 5) {
    const c = chunks[i];
    const buf = Buffer.allocUnsafe(c.end - c.start);
    await reader.read(buf, 0, buf.length, c.start);
    createHash('sha256').update(buf).digest();
  }
  await reader.close();
  const readbackMs = performance.now() - t3;
  await fsp.unlink(path);
  return {sizeMiB:size, captureMs, indexMs, judgePrepMs, readbackMs, totalMs:performance.now()-t0, chunks:chunks.length, lines, wireMiB:wireBytes/MiB, selectedMiB:acceptedBytes/MiB};
}

if (process.argv[2] === 'case') {
  const size = Number(process.argv[3]), concurrency = Number(process.argv[4]);
  const delay = monitorEventLoopDelay({resolution: 5}); delay.enable();
  await new Promise(r => setTimeout(r, 30));
  const rssBaseline = process.memoryUsage().rss;
  let peakRss = rssBaseline;
  const timer = setInterval(() => peakRss = Math.max(peakRss, process.memoryUsage().rss), 5);
  const cpuStart = process.cpuUsage(), t = performance.now();
  const results = await Promise.all(Array.from({length:concurrency}, (_,i) => one(size, `${process.pid}-${i}`)));
  const wallMs = performance.now()-t, cpu = process.cpuUsage(cpuStart);
  await new Promise(r => setTimeout(r, 20));
  clearInterval(timer); delay.disable();
  console.log(JSON.stringify({size, concurrency, wallMs, cpuMs:(cpu.user+cpu.system)/1000, baselineRssMiB:rssBaseline/MiB, peakRssMiB:Math.max(peakRss,process.memoryUsage().rss)/MiB, maxRssMiB:process.resourceUsage().maxRSS/1024, loopP99Ms:delay.percentile(99)/1e6, loopMaxMs:delay.max/1e6, results}));
} else if (process.argv[2] === 'cancel') {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>process.stdout.write(Buffer.alloc(65536)),1)'], {stdio:['ignore','pipe','ignore']});
  const controller = new AbortController();
  let bytes = 0, issued = 0;
  const exited = new Promise(r => child.on('exit', r));
  const timer = setTimeout(() => { issued = performance.now(); controller.abort(); child.kill('SIGTERM'); }, 100);
  try { await pipeline(child.stdout, new Writable({write(b,e,cb){bytes+=b.length; cb();}}), {signal:controller.signal}); } catch(e) { if(e.name!=='AbortError') throw e; }
  await exited; clearTimeout(timer);
  console.log(JSON.stringify({cancelToExitMs:performance.now()-issued, bytes, pid:child.pid}));
} else {
  const output = {environment:{node:process.version, arch:process.arch, platform:process.platform, cpus:os.cpus()[0]?.model, logicalCpus:os.cpus().length, totalMemoryGiB:os.totalmem()/MiB/1024}, cases:[], cancellations:[]};
  async function run(args) {
    const child = spawn(process.execPath, [import.meta.filename,...args]); let out='',err='';
    child.stdout.on('data', b=>out+=b); child.stderr.on('data',b=>err+=b);
    await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',c=>c===0?resolve():reject(Error(err)));});
    return JSON.parse(out);
  }
  for (const [size, concurrency] of [[1,1],[10,1],[100,1],[10,4],[100,4]]) {
    for(let repeat=0;repeat<3;repeat++) output.cases.push(await run(['case',String(size),String(concurrency)]));
  }
  for(let i=0;i<5;i++) output.cancellations.push(await run(['cancel']));
  await fsp.writeFile(`${root}/results.json`, JSON.stringify(output,null,2));
  console.log(JSON.stringify(output));
}
