import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Game} from '../apps/server/game.mjs';
import {Diagnostics} from '../apps/server/diagnostics.mjs';
import {createApp} from '../apps/server/main.mjs';
import {hardware} from '../apps/server/hardware.mjs';
import {WebSocket} from 'ws';

const devices=[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`key-${n}`,name:`P${n}`,shooterId:n}));
function diagnosticFrame(shooter,seq){
  const upper=(1<<22)|(shooter<<14)|(seq<<6)|(1<<2)|1;
  let crc=0;
  for(const shift of [16,8,0]){crc^=(upper>>>shift)&255;for(let bit=0;bit<8;bit++)crc=((crc<<1)^((crc&128)?7:0))&255;}
  return `0x${(((upper<<8)|crc)>>>0).toString(16).padStart(8,'0')}`;
}

test('一時診断の射撃と受信は試合を止め、戦績を一切変更しない',()=>{
  let now=100000;
  const game=new Game(devices,{now:()=>now});
  for(const player of game.s.players){player.connected=true;player.diagnosticCapable=true;player.bootId=`boot-${player.id}`;}
  game.s.phase='ACTIVE';game.s.participantIds=devices.map(d=>d.id);game.s.endAt=now+45000;game.s.remainingMs=45000;
  const diagnostics=new Diagnostics({now:()=>now});
  diagnostics.begin(game);
  assert.equal(game.s.phase,'PAUSED');
  assert.equal(game.s.pauseReason,'一時診断中');
  assert.equal(game.s.remainingMs,45000);
  const envelope=(id,type,payload,messageId)=>({device_id:id,boot_id:`boot-${id}`,game_id:game.s.id,game_generation:game.s.generation,message_id:messageId,seq:1,server_time_ms:now,type,payload});
  assert.equal(diagnostics.receive(game,'gun-001',envelope('gun-001','diagnostic_shot',{shooter_id:1,shot_seq:8},'shot-1')).ok,true);
  const frame=diagnosticFrame(1,8);
  const hit=envelope('gun-002','diagnostic_hit',{frame,shooter_id:1,shot_seq:8,receiver_id:'rx1'},'hit-1');
  assert.equal(diagnostics.receive(game,'gun-002',hit).ok,true);
  assert.equal(diagnostics.receive(game,'gun-002',hit).reason,'duplicate');
  assert.deepEqual(game.s.players.map(p=>[p.kills,p.deaths,p.shots,p.hits,p.hp]),Array.from({length:4},()=>[0,0,0,0,1]));
  assert.equal(diagnostics.state('gun-002').hp,0);
  assert.equal(diagnostics.state('gun-001').kills,1);
  now+=6999;diagnostics.tick();assert.equal(diagnostics.state('gun-002').hp,0);
  now+=1;diagnostics.tick();assert.equal(diagnostics.state('gun-002').hp,1);
  assert.equal(diagnostics.view().events.length,3);
  diagnostics.end(game);
  assert.equal(game.s.phase,'PAUSED');
  assert.equal(diagnostics.receive(game,'gun-001',envelope('gun-001','diagnostic_shot',{shooter_id:1,shot_seq:9},'shot-2')).reason,'diagnostic_off');
});

test('診断中は受信報告が射撃報告より先でも命中を照合する',()=>{
  let now=200000;
  const game=new Game(devices,{now:()=>now});
  for(const player of game.s.players){player.connected=true;player.diagnosticCapable=true;player.bootId=`boot-${player.id}`;}
  const diagnostics=new Diagnostics({now:()=>now});diagnostics.begin(game);
  const envelope=(id,type,payload,messageId)=>({device_id:id,boot_id:`boot-${id}`,game_id:game.s.id,game_generation:game.s.generation,message_id:messageId,seq:1,server_time_ms:now,type,payload});
  const hit=envelope('gun-002','diagnostic_hit',{frame:diagnosticFrame(1,5),shooter_id:1,shot_seq:5,receiver_id:'rx2'},'hit-first');
  assert.equal(diagnostics.receive(game,'gun-002',hit).pending,true);
  assert.equal(diagnostics.state('gun-002').hp,1);
  now+=100;
  const shot=envelope('gun-001','diagnostic_shot',{shooter_id:1,shot_seq:5},'shot-later');
  assert.equal(diagnostics.receive(game,'gun-001',shot).changed,true);
  assert.equal(diagnostics.state('gun-002').hp,0);
  assert.equal(diagnostics.state('gun-001').kills,1);
  assert.deepEqual(game.s.players.map(player=>player.kills),[0,0,0,0]);
});

test('本番APIで中間発表の自動進行を保留し、診断終了後に復元する',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-diagnostic-'));
  const app=await createApp({config:{httpPort:0,mqttPort:0,operatorPin:'12345678',devices},dataDir:dir,bind:'127.0.0.1'});
  try{
    const base=`http://127.0.0.1:${app.httpServer.address().port}`;
    const loginResponse=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'12345678'})});
    const login=await loginResponse.json(),cookie=loginResponse.headers.get('set-cookie').split(';')[0];
    let seq=0;
    const action=(name)=>fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':login.csrf},body:JSON.stringify({action:name,commandId:`diagnostic-${++seq}`})});
    const player=app.game.player('gun-001');player.connected=true;player.diagnosticCapable=true;player.lastSeen=Date.now();
    app.game.s.phase='INTERMISSION';app.game.s.round=2;app.game.s.intermissionEndsAt=Date.now()+10000;
    assert.equal((await action('diagnostic_on')).status,200);
    const during=await (await fetch(`${base}/api/state`)).json();
    assert.equal(during.diagnostics.enabled,true);
    assert.equal(during.diagnostics.intermissionHeld,true);
    assert.equal(during.intermissionEndsAt,null);
    assert.equal((await action('start')).status,400);
    assert.equal((await action('diagnostic_off')).status,200);
    const after=await (await fetch(`${base}/api/state`)).json();
    assert.equal(after.diagnostics.enabled,false);
    assert.ok(after.intermissionEndsAt>Date.now()+8000);
    assert.deepEqual(after.players.map(p=>p.kills),[0,0,0,0]);
  }finally{await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('説明動画と同時に無得点の撃ち合い診断を始め、ゲーム開始で解除する',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-video-diagnostic-'));
  const app=await createApp({config:{httpPort:0,mqttPort:0,operatorPin:'12345678',devices},demo:true,demoSource:'devices',dataDir:dir,bind:'127.0.0.1'});
  let display;
  try{
    const base=`http://127.0.0.1:${app.httpServer.address().port}`;
    const loginResponse=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:'12345678'})});
    const login=await loginResponse.json(),cookie=loginResponse.headers.get('set-cookie').split(';')[0];
    let seq=0;
    const action=(name,extra={})=>fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':login.csrf},body:JSON.stringify({action:name,commandId:`video-diagnostic-${++seq}`,...extra})});
    display=new WebSocket(`${base.replace('http','ws')}/ws/display`,{headers:{Origin:base}});
    await new Promise((resolve,reject)=>{display.once('open',resolve);display.once('error',reject);});
    display.send(JSON.stringify({type:'ready',ready:true}));
    assert.equal((await action('video',{operation:'restart'})).status,200);
    assert.equal((await action('start',{testMode:true})).status,400);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).diagnostics.enabled,true);
    app.game.hello('gun-001','boot-video');
    app.game.heartbeat('gun-001',{syncRtt:10,hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.8.2-4e42',diagnostic_capable:true});
    const during=await (await fetch(`${base}/api/state`)).json();
    assert.equal(during.media,'video');
    assert.equal(during.diagnostics.enabled,true);
    assert.deepEqual(during.players.map(p=>p.kills),[0,0,0,0]);
    assert.equal((await action('start',{testMode:true})).status,200);
    const after=await (await fetch(`${base}/api/state`)).json();
    assert.equal(after.diagnostics.enabled,false);
    assert.equal(after.phase,'COUNTDOWN');
    assert.equal(after.media,'score');
  }finally{display?.terminate();await app.close();rmSync(dir,{recursive:true,force:true});}
});
