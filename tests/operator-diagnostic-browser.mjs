import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import mqtt from 'mqtt';
import {createApp} from '../apps/server/main.mjs';
import {hardware} from '../apps/server/hardware.mjs';

const require=createRequire(import.meta.url);
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
const dir=mkdtempSync(path.join(os.tmpdir(),'arena-diagnostic-browser-'));
const config={httpPort:0,mqttPort:0,operatorPin:'12345678',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`key-${n}`,name:`プレイヤー${n}`,shooterId:n}))};
const app=await createApp({config,dataDir:dir,bind:'127.0.0.1'});
const base=`http://127.0.0.1:${app.httpServer.address().port}`;
function diagnosticFrame(shooter,seq){const upper=(1<<22)|(shooter<<14)|(seq<<6)|(1<<2)|1;let crc=0;for(const shift of [16,8,0]){crc^=(upper>>>shift)&255;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&128)?7:0))&255;}return `0x${(((upper<<8)|crc)>>>0).toString(16).padStart(8,'0')}`;}
let browser,client,client2,timer;
try{
  browser=await chromium.launch({channel:'msedge',headless:true});
  const page=await browser.newPage({viewport:{width:1440,height:900}});
  const waitFor=async (predicate,arg,options={})=>{
    const until=Date.now()+(options.timeout??15000);
    while(Date.now()<until){if(await page.evaluate(predicate,arg))return;await page.waitForTimeout(100);}
    throw Error('Timed out waiting for operator state');
  };
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  await page.goto(base);
  await page.locator('#pin').fill(config.operatorPin);
  await page.getByRole('button',{name:'ログイン'}).click();
  await page.locator('#dashboard').waitFor({state:'visible'});
  assert.match(await page.locator('#players .player').first().getAttribute('class'),/is-offline/);
  const topic='irgame/v1/device/gun-001';
  client=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-001',username:'gun-001',password:'key-1',reconnectPeriod:0});
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  await client.publishAsync(`${topic}/hello`,JSON.stringify({boot_id:'diagnostic-boot'}),{qos:1});
  let presses=0,down=false,motor=false,motorPulses=0,ledColor='BLUE';
  const telemetry=()=>client.publish(`${topic}/telemetry`,JSON.stringify({boot_id:'diagnostic-boot',hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.8.2-4e42',diagnostic_capable:true,diagnostic_mode:true,trigger_down:down,trigger_presses:presses,motor_active:motor,motor_pulses:motorPulses,led_color:ledColor,bench:false,lowBattery:false,battery:9,syncRtt:4,device_time_ms:Date.now()}));
  const topic2='irgame/v1/device/gun-002';
  client2=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-002',username:'gun-002',password:'key-2',reconnectPeriod:0});
  await new Promise((resolve,reject)=>{client2.once('connect',resolve);client2.once('error',reject);});
  await client2.publishAsync(`${topic2}/hello`,JSON.stringify({boot_id:'diagnostic-boot-2'}),{qos:1});
  const telemetry2=()=>client2.publish(`${topic2}/telemetry`,JSON.stringify({boot_id:'diagnostic-boot-2',hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.8.2-4e42',diagnostic_capable:true,diagnostic_mode:true,bench:false,lowBattery:false,battery:9,syncRtt:4,device_time_ms:Date.now()}));
  telemetry();telemetry2();timer=setInterval(()=>{telemetry();telemetry2();},450);
  await waitFor(()=>document.querySelector('#players .player')?.classList.contains('is-connected'));
  assert.equal(await page.locator('#diagnosticPanel').isVisible(),true);
  await page.locator('#diagnosticToggle').click();
  await waitFor(()=>document.querySelector('#diagnosticBadge')?.textContent.includes('診断中'));
  const state=await (await fetch(`${base}/api/state`)).json();
  await client.publishAsync(`${topic}/event`,JSON.stringify({device_id:'gun-001',boot_id:'diagnostic-boot',seq:1,server_time_ms:Date.now(),message_id:'diagnostic-shot-1',game_id:state.id,game_generation:state.generation,type:'diagnostic_shot',payload:{shooter_id:1,shot_seq:7}}),{qos:1});
  await waitFor(()=>document.querySelector('#diagnosticLog')?.textContent.includes('診断射撃'));
  await client2.publishAsync(`${topic2}/event`,JSON.stringify({device_id:'gun-002',boot_id:'diagnostic-boot-2',seq:1,server_time_ms:Date.now(),message_id:'diagnostic-shot-2',game_id:state.id,game_generation:state.generation,type:'diagnostic_shot',payload:{shooter_id:2,shot_seq:4}}),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify({device_id:'gun-001',boot_id:'diagnostic-boot',seq:2,server_time_ms:Date.now(),message_id:'diagnostic-hit-1',game_id:state.id,game_generation:state.generation,type:'diagnostic_hit',payload:{frame:diagnosticFrame(2,4),shooter_id:2,shot_seq:4,receiver_id:'rx2'}}),{qos:1});
  await waitFor(()=>document.querySelector('#diagnosticLog')?.textContent.includes('左で撃破'));
  assert.match(await page.locator('#diagnosticCombat').innerText(),/撃破・\d+秒で復活/);
  down=true;presses=1;motor=true;motorPulses=1;ledColor='RED';telemetry();
  await waitFor(()=>document.querySelector('#players .player')?.classList.contains('is-triggered'));
  assert.match(await page.locator('#players .player').first().innerText(),/押下中/);
  assert.match(await page.locator('#players .player').first().innerText(),/動作中/);
  assert.match(await page.locator('#players .player').first().innerText(),/赤/);
  assert.equal(app.game.player('gun-001').shots,0);
  assert.equal(app.game.player('gun-001').kills,0);
  mkdirSync('artifacts/browser',{recursive:true});
  await page.screenshot({path:'artifacts/browser/operator-diagnostic.png',fullPage:true});
  await page.locator('#diagnosticToggle').click();
  await waitFor(()=>document.querySelector('#diagnosticBadge')?.textContent==='停止中');
  assert.deepEqual(errors,[]);
  console.log('Operator diagnostic browser: PASS');
}finally{
  clearInterval(timer);
  await client2?.endAsync(true);
  await client?.endAsync(true);
  await browser?.close();
  await app.close();
  rmSync(dir,{recursive:true,force:true});
}
