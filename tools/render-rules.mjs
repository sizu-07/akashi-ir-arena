import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {slides} from '../apps/web/rules-content.js';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const width=1280,height=720,secondsPerSlide=7,durationMs=slides.length*secondsPerSlide*1000;
mkdirSync('assets/build',{recursive:true});
const browser=await chromium.launch({channel:'msedge',headless:true});
let frames;
try{
  const page=await browser.newPage({viewport:{width,height},deviceScaleFactor:1});frames=[];
  for(let i=0;i<slides.length;i++){
    const [title,...lines]=slides[i];
    await page.setContent(`<!doctype html><html lang="ja"><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:#0a1626;color:#f5f8fb;font-family:'Yu Gothic','Meiryo',sans-serif;padding:62px 76px}header{display:flex;justify-content:space-between;align-items:center;color:#8da4bd;font-size:22px;letter-spacing:3px}.teams{display:flex;gap:8px}.teams b{padding:8px 18px;background:#075370;color:#74e4fa;border-radius:6px}.teams b+b{background:#633b0b;color:#ffd085}h1{font-size:62px;letter-spacing:2px;margin:102px 0 40px;font-weight:700}p{font-size:30px;line-height:1.8;margin:8px 0;color:#d2dfed}footer{position:absolute;left:76px;right:76px;bottom:48px;display:flex;align-items:center;gap:12px;color:#8da4bd;font-size:18px}i{height:5px;width:68px;border-radius:6px;background:#273b52}i.on{background:#57d8f1}span{margin-left:auto}</style><header>AKASHI / IR ARENA <div class="teams"><b>A · 2人</b><b>B · 2人</b></div></header><h1>${title}</h1>${lines.map(t=>`<p>${t}</p>`).join('')}<footer>${slides.map((_,j)=>`<i class="${j<=i?'on':''}"></i>`).join('')}<span>参加前にご確認ください　${i+1} / ${slides.length}</span></footer></html>`);
    const png=await page.screenshot({path:`assets/build/rule-${String(i).padStart(2,'0')}.png`});
    frames.push(`data:image/png;base64,${png.toString('base64')}`);
  }
  const recorder=await browser.newPage({viewport:{width,height}});
  const base64=await recorder.evaluate(async ({frames,width,height,durationMs,secondsPerSlide})=>{
    if(!MediaRecorder.isTypeSupported('video/webm;codecs=vp8'))throw Error('Edge MediaRecorder cannot encode VP8 WebM');
    const images=await Promise.all(frames.map(src=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=reject;img.src=src;})));
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');
    const stream=canvas.captureStream(25),chunks=[];
    const media=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp8',videoBitsPerSecond:2500000});
    const completed=new Promise((resolve,reject)=>{media.ondataavailable=e=>{if(e.data.size)chunks.push(e.data);};media.onerror=e=>reject(e.error||Error('MediaRecorder failed'));media.onstop=resolve;});
    media.start();const started=performance.now();
    await new Promise(resolve=>{function draw(){const elapsed=performance.now()-started;ctx.drawImage(images[Math.min(images.length-1,Math.floor(elapsed/(secondsPerSlide*1000)))],0,0);if(elapsed<durationMs)requestAnimationFrame(draw);else resolve();}draw();});
    media.stop();await completed;stream.getTracks().forEach(track=>track.stop());
    const blob=new Blob(chunks,{type:'video/webm'});
    return await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(blob);});
  },{frames,width,height,durationMs,secondsPerSlide});
  writeFileSync('assets/rules.webm',Buffer.from(base64,'base64'));
}finally{await browser.close();}
const output='assets/rules.webm';
writeFileSync('assets/render-report.json',JSON.stringify({durationSeconds:durationMs/1000,size:[width,height],video:'VP8 WebM 25fps',audio:'none; projector countdown and BGM remain separate',slides:slides.length,sha256:createHash('sha256').update(readFileSync(output)).digest('hex'),toolSource:'Edge MediaRecorder'},null,2));
console.log(`${output} rendered: ${durationMs/1000} seconds, ${slides.length} slides`);
