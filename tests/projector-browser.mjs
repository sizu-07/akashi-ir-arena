import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {createApp} from '../apps/server/main.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=mkdtempSync(path.join(os.tmpdir(),'arena-projector-'));
const output='artifacts/projector';
mkdirSync(output,{recursive:true});
const config={httpPort:0,mqttPort:0,operatorPin:'projector-test-only',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`test-${n}`,name:`プレイヤー${n}`,shooterId:n}))};
const app=await createApp({config,demo:true,dataDir:dir,bind:'127.0.0.1'});
const base=`http://127.0.0.1:${app.httpServer.address().port}`;
let browser;
const errors=[];
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1920,height:1080}});
  const waitFor=async (predicate,arg,options={})=>{
    const until=Date.now()+(options.timeout??15000);
    while(Date.now()<until){if(await page.evaluate(predicate,arg))return;await page.waitForTimeout(100);}
    throw Error('Timed out waiting for projector state');
  };
  page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`${base}/display`);
  await page.locator('.standby-slot').first().waitFor();
  assert.equal(await page.locator('.standby-slot').count(),4);
  assert.deepEqual(await page.locator('.standby-slot h3').allTextContents(),['プレイヤー1','プレイヤー2','プレイヤー3','プレイヤー4']);
  assert.equal(await page.locator('.standby-intro h2').textContent(),'STAND HERE.');
  assert.equal(await page.locator('.player').count(),4);
  assert.equal(await page.locator('.player').first().isVisible(),false);
  assert.equal(await page.locator('#round').textContent(),'1 / 3');
  await page.screenshot({path:`${output}/lobby-1920.png`});
  await page.setViewportSize({width:1280,height:720});
  await page.screenshot({path:`${output}/lobby-1280.png`});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'lobby 1280px horizontal overflow');
  await page.setViewportSize({width:1920,height:1080});
  const mobileLobby=await browser.newPage({viewport:{width:390,height:844}});
  await mobileLobby.goto(`${base}/display`);
  await mobileLobby.locator('.standby-slot').first().waitFor();
  await mobileLobby.screenshot({path:`${output}/lobby-390.png`});
  assert.equal(await mobileLobby.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'lobby 390px horizontal overflow');
  await mobileLobby.close();
  await page.locator('#prepare').click();
  await waitFor(async()=>{const s=await(await fetch('/api/state')).json();return s.displayReady&&s.players.every(p=>p.connected&&p.syncRtt!==null);});
  const bgmDuration = await page.evaluate(async () => {
    const response = await fetch('/bgm.mp3');
    const context = new AudioContext();
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    await context.close();
    return buffer.duration;
  });
  assert.ok(bgmDuration > 88 && bgmDuration < 90, `BGM length ${bgmDuration}s`);
  app.game.start(true);
  for (const player of app.game.s.players) app.game.ack(player.id,{command_id:app.game.s.commandId,result:'ok'});
  try{await waitFor(()=>document.body.dataset.phase==='ACTIVE',undefined,{timeout:15000});}
  catch(error){throw Error(`投影開始待ち: phase=${app.game.s.phase}, ACK=${app.game.s.startCommitted}, ready=${app.game.s.players.map(p=>p.connected).join(',')}: ${error.message}`);}
  assert.equal(await page.locator('#standby').isVisible(),false);
  assert.equal(await page.locator('.player').first().isVisible(),true);
  assert.equal(await page.locator('#clock').textContent(),'01:30');
  await waitFor(()=>document.body.dataset.bgm==='playing');
  assert.ok(Number(await page.locator('body').getAttribute('data-bgm-offset-ms'))<2000);
  const shooter=app.game.player('gun-001'),victim=app.game.player('gun-002');
  shooter.kills=2;shooter.shots=3;shooter.hitShots=2;shooter.accuracy=66.7;
  victim.hp=0;victim.deaths=2;victim.respawnAt=Date.now()+7000;
  await waitFor(()=>document.getElementById('leader').textContent==='プレイヤー1'&&document.querySelector('.is-out'));
  assert.equal(await page.locator('.player').first().locator('.hp').textContent(),'2');
  await page.screenshot({path:`${output}/active-1920.png`});
  app.game.s.endAt=Date.now()+70000;
  app.game.tick(true);
  app.game.pause();
  await waitFor(()=>document.body.dataset.phase==='PAUSED');
  await waitFor(()=>!document.body.dataset.bgm);
  app.game.start(true);
  for (const player of app.game.s.players) app.game.ack(player.id,{command_id:app.game.s.commandId,result:'ok'});
  await waitFor(()=>document.body.dataset.phase==='ACTIVE'&&document.body.dataset.bgm==='playing',undefined,{timeout:15000});
  const resumedBgmOffset=Number(await page.locator('body').getAttribute('data-bgm-offset-ms'));
  assert.ok(resumedBgmOffset>=14000&&resumedBgmOffset<17000,`BGM resumed at ${resumedBgmOffset} ms`);
  app.game.pause();
  await waitFor(()=>document.body.dataset.phase==='PAUSED');
  app.game.endRound('demo_skip');
  await waitFor(()=>document.getElementById('overlayTitle').textContent==='途中経過');
  assert.equal(await page.locator('#round').textContent(),'2 / 3');
  assert.equal(await page.locator('#resultBoard .result-row').count(),4);
  assert.match(await page.locator('#resultBoard .result-row').first().innerText(),/プレイヤー1[\s\S]*2/);
  await page.waitForTimeout(700);
  assert.ok(Number((await page.locator('#resultBoard .result-stats strong').first().evaluate(node=>getComputedStyle(node).fontSize)).replace('px',''))>=32);
  await page.screenshot({path:`${output}/intermission-1920.png`});
  app.game.s.round=3;
  app.game.s.phase='PAUSED';
  app.game.finish();
  await waitFor(()=>document.body.dataset.phase==='FINISHED');
  assert.equal(await page.locator('#overlayTitle').textContent(),'優勝');
  assert.equal(await page.locator('#resultChampion').textContent(),'プレイヤー1');
  await page.waitForTimeout(700);
  await page.screenshot({path:`${output}/winner-1920.png`});
  for(const [width,height] of [[1280,720],[390,844]]){
    await page.setViewportSize({width,height});
    await page.screenshot({path:`${output}/winner-${width}.png`});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${width}px horizontal overflow`);
  }
  await page.setViewportSize({width:1920,height:1080});
  app.game.setMedia('video');
  await waitFor(()=>!document.getElementById('video').hidden);
  if(await page.locator('#prepare').isVisible())await page.locator('#prepare').click();
  await waitFor(()=>document.getElementById('video').currentTime>0.2,undefined,{timeout:15000});
  assert.equal(await page.evaluate(()=>document.getElementById('video').error),null);
  await page.screenshot({path:`${output}/rules-video-1920.png`});
  assert.deepEqual(errors,[]);
  writeFileSync(`${output}/result.json`,JSON.stringify({revision:'0.8',checkedAt:new Date().toISOString(),passed:true,checks:['four-player position guide','four-player ranking','kill and death display','intermediate standings','individual winner','1280 and 390 px layouts','rules video plays'],errors},null,2));
  console.log('Projector browser: PASS');
}finally{
  await browser?.close();
  await app.close();
  rmSync(dir,{recursive:true,force:true});
}
