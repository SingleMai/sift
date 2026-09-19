use std::{sync::Arc, time::Instant, os::unix::fs::FileExt, process::Stdio};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use futures::{stream, StreamExt, TryStreamExt};
use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest,Sha256};
type Error = Box<dyn std::error::Error + Send + Sync>;
const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/..");
const MIB: usize = 1024*1024;
#[derive(Clone)] struct Chunk { start:usize, end:usize }
#[derive(Serialize)] struct Payload<'a> { purpose:&'a str, command:&'a str, start:usize, end:usize, context:std::borrow::Cow<'a,str> }
fn ms(t:Instant)->f64 { t.elapsed().as_secs_f64()*1000.0 }
async fn read_at(file:Arc<std::fs::File>,start:usize,len:usize)->Result<Vec<u8>,Error> {
    Ok(tokio::task::spawn_blocking(move || { let mut b=vec![0;len]; file.read_exact_at(&mut b,start as u64)?; Ok::<_,std::io::Error>(b) }).await??)
}
async fn one(size:usize,id:usize,cap:bool)->Result<Value,Error> {
    let path=format!("{ROOT}/rust-capture-{}-{id}",std::process::id());
    let begin=Instant::now();
    // Identical Node producer for all implementations, to isolate consumer behavior.
    let mut child=tokio::process::Command::new(std::env::var("NODE_BIN")?).args([format!("{ROOT}/bench.mjs"),"produce".into(),(size*MIB).to_string()]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn()?;
    let mut out=child.stdout.take().unwrap();
    let mut file=tokio::fs::File::create(&path).await?;
    let mut buf=vec![0u8;65536];
    loop { let n=out.read(&mut buf).await?; if n==0 {break} file.write_all(&buf[..n]).await?; }
    file.flush().await?; drop(file);
    assert!(child.wait().await?.success());
    let capture=ms(begin); let t=Instant::now();
    let mut file=tokio::fs::File::open(&path).await?;
    let mut bytes=0; let mut start=0; let mut lines=0; let mut chunks=Vec::new();
    loop {
        let n=file.read(&mut buf).await?; if n==0 {break}
        let cap_until=|end:usize,start:&mut usize,chunks:&mut Vec<Chunk>| {
            if cap { while end-*start>16384 { let mut cut=(*start+8192).max(bytes); while cut<end && (buf[cut-bytes]&0xc0)==0x80 {cut+=1} chunks.push(Chunk{start:*start,end:cut}); *start=cut; } }
        };
        for at in memchr::memchr_iter(10,&buf[..n]) { lines+=1; let end=bytes+at+1; cap_until(end,&mut start,&mut chunks); if end-start>=8192 {chunks.push(Chunk{start,end});start=end} }
        cap_until(bytes+n,&mut start,&mut chunks); bytes+=n;
    }
    if start<bytes {chunks.push(Chunk{start,end:bytes})}
    let mut end=0; for c in &chunks {assert_eq!(c.start,end);assert!(c.end>c.start);end=c.end;} assert_eq!(end,size*MIB);
    let index=ms(t); let file=Arc::new(std::fs::File::open(&path)?); let t=Instant::now();
    let results:Vec<(usize,usize)>=stream::iter(chunks.iter().enumerate().map(|(n,c)| {
        let file=file.clone(); async move {
            let lo=c.start.saturating_sub(2048); let hi=(c.end+2048).min(bytes);
            let buf=read_at(file,lo,hi-lo).await?;
            let payload=serde_json::to_vec(&Payload{purpose:"定位请求失败的证据与反证",command:"synthetic-output",start:c.start,end:c.end,context:String::from_utf8_lossy(&buf)})?;
            let score=Sha256::digest(&payload)[0] as f64/255.0;
            let response:Value=serde_json::from_slice(&serde_json::to_vec(&json!({"relevance":score}))?)?;
            let s=response["relevance"].as_f64().unwrap(); assert!(s.is_finite() && (0.0..=1.0).contains(&s));
            Ok::<_,Error>((payload.len(),if n%5==0 {c.end-c.start} else {0}))
        }
    })).buffer_unordered(4).try_collect().await?;
    assert_eq!(results.len(),chunks.len()); let prep=ms(t);let t=Instant::now();
    for c in chunks.iter().step_by(5) {let buf=read_at(file.clone(),c.start,c.end-c.start).await?;std::hint::black_box(Sha256::digest(&buf));}
    let readback=ms(t); drop(file);tokio::fs::remove_file(path).await?;
    Ok(json!({"sizeMiB":size,"captureMs":capture,"indexMs":index,"judgePrepMs":prep,"readbackMs":readback,"totalMs":ms(begin),"chunks":chunks.len(),"lines":lines,"wireMiB":results.iter().map(|x|x.0).sum::<usize>() as f64/MIB as f64,"selectedMiB":results.iter().map(|x|x.1).sum::<usize>() as f64/MIB as f64}))
}
#[tokio::main(flavor="current_thread")]
async fn main()->Result<(),Error> {
    let args:Vec<_>=std::env::args().collect(); let size=args[1].parse::<usize>()?;let concurrency=args[2].parse::<usize>()?;
    let cap=std::env::var("BENCH_HARD_CAP").as_deref()==Ok("1");let t=Instant::now();
    let results=futures::future::try_join_all((0..concurrency).map(|id|one(size,id,cap))).await?;
    let wall=ms(t); let mut usage=std::mem::MaybeUninit::<libc::rusage>::zeroed();
    let usage=unsafe {assert_eq!(libc::getrusage(libc::RUSAGE_SELF,usage.as_mut_ptr()),0);usage.assume_init()};
    println!("{}",json!({"size":size,"concurrency":concurrency,"wallMs":wall,"maxRssMiB":usage.ru_maxrss as f64/MIB as f64,"results":results})); Ok(())
}
