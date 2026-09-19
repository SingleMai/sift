import {spawn} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import fs from 'node:fs/promises';
const root=import.meta.dirname;
if (process.platform !== 'darwin') throw Error('This benchmark currently targets macOS RSS units and filesystem behavior.');
const all=[];
const variants=['native','effect','rust'];
for(const [size,concurrency,long] of [[1,1,false],[10,1,false],[100,1,false],[10,4,false],[100,4,false],[100,1,true]]) {
  for(let repeat=0;repeat<5;repeat++) {
    for(let j=0;j<3;j++) {
      const variant=variants[(j+repeat)%3];
      const env={...process.env,NODE_BIN:process.execPath,BENCH_EFFECT:variant==='effect'?'1':'0',BENCH_HARD_CAP:'1',BENCH_LONG_LINE:long?'1':'0'};
      const command=variant==='rust'?`${root}/rust/target/release/pipeline-bench`:process.execPath;
      const args=variant==='rust'?[String(size),String(concurrency)]:[`${root}/compare-node.mjs`,'case',String(size),String(concurrency)];
      const t=performance.now();const child=spawn(command,args,{env});let out='',err='';
      child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);
      await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(err)));});
      const result={variant,size,concurrency,long,repeat,processWallMs:performance.now()-t,...JSON.parse(out)};
      all.push(result);
      await fs.writeFile(`${root}/comparison-results.latest.json`,JSON.stringify(all,null,2));
    }
  }
  const group=all.filter(x=>x.size===size&&x.concurrency===concurrency&&x.long===long);
  const expected=group[0].results.map(x=>[x.chunks,x.lines,x.wireMiB,x.selectedMiB]);
  for(const g of group) if(JSON.stringify(g.results.map(x=>[x.chunks,x.lines,x.wireMiB,x.selectedMiB]))!==JSON.stringify(expected))throw Error(`workload differs: ${JSON.stringify(g)}`);
  const med=a=>a.sort((a,b)=>a-b)[Math.floor(a.length/2)];
  console.log(JSON.stringify({size,concurrency,long,variants:variants.map(v=>{const a=group.filter(x=>x.variant===v);return {variant:v,wallMs:med(a.map(x=>x.wallMs)),rssMiB:med(a.map(x=>x.maxRssMiB)),stages:Object.fromEntries(['captureMs','indexMs','judgePrepMs','readbackMs'].map(k=>[k,med(a.map(x=>x.results[0][k]))]))}})}));
}
