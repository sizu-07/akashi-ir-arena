import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../apps/server/game.mjs';
import {decodeGameFrame} from '../apps/server/ir-frame.mjs';
import {hardware,receiverOnlyProfile,deviceReady} from '../apps/server/hardware.mjs';
import {createApp} from '../apps/server/main.mjs';
import {mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import mqtt from 'mqtt';
const devices=[1,2,3,4].map(n=>({id:`gun-00${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n,key:`test-${n}`}));
const full={hardware_profile:hardware.profile,hardware_ready:true,bench:false,lowBattery:false,syncRtt:5};
const rx={...full,hardware_profile:receiverOnlyProfile,firmware_version:'0.7.1-rx44',last_ir:{frame:'0x40454447',receiver_id:'rx1',device_time_ms:1000},rx_frames:{rx1:1}};
test('captured real IR frame and receiver telemetry identify player1 against player3',()=>{
  assert.deepEqual(decodeGameFrame('0x40454447'),{shooterId:1,seq:21,weapon:1,flags:0});
  assert.equal(decodeGameFrame('0x40454446'),null);
  const game=new Game(devices);game.hello('gun-003','boot');game.heartbeat('gun-003',rx);
  assert.equal(deviceReady(game.player('gun-003')),true);
  assert.equal(game.player('gun-003').battery,null);
  assert.equal(game.player('gun-003').lastIr.relation,'ENEMY');
  assert.equal(game.player('gun-003').lastIr.sourceName,'P1');
  assert.equal(game.player('gun-001').connected,false);
  assert.equal(game.player('gun-003').hp,100);
  game.heartbeat('gun-003',{...rx,last_ir:{frame:'0x40454446',receiver_id:'rx1'}});
  assert.equal(game.player('gun-003').lastIr,null);
});
test('receiver uses real start ACK and hit_candidate, requires matching shot, cannot fire',()=>{
  let now=100000,n=0;const game=new Game(devices,{now:()=>now});
  for(const id of ['gun-001','gun-003']){game.hello(id,'boot');game.heartbeat(id,id==='gun-003'?rx:full);}
  assert.throws(()=>game.start(true),/受信専用/);
  game.start(true,{testMode:true});assert.equal(game.s.startCommitted,false);
  game.ack('gun-001',{command_id:game.s.commandId,result:'ok'});
  game.ack('gun-003',{command_id:game.s.commandId,result:'ok'});assert.equal(game.s.startCommitted,true);
  now=game.s.startAt;for(const id of ['gun-001','gun-003'])game.heartbeat(id,id==='gun-003'?rx:full);game.tick();
  assert.equal(game.player('gun-003').armed,true);
  const event=(id,type,payload)=>game.event(id,{device_id:id,boot_id:'boot',seq:++n,message_id:String(n),game_id:game.s.id,game_generation:game.s.generation,server_time_ms:now,type,payload});
  const candidate={shooter_id:1,shot_seq:21,weapon_id:1,flags:0,receiver_id:'rx1'};
  assert.equal(event('gun-003','hit_candidate',candidate).reason,'pending');assert.equal(game.player('gun-003').hp,100);
  assert.equal(event('gun-001','shot_fired',{shot_seq:21,weapon_id:1}).ok,true);
  assert.equal(game.player('gun-003').hp,95);assert.equal(game.player('gun-003').lastReceiver,'rx1');
  assert.equal(event('gun-003','shot_fired',{shot_seq:1,weapon_id:1}).reason,'receiver_only');
  game.pause();assert.equal(event('gun-003','hit_candidate',candidate).reason,'not_active');
});
test('production MQTT supplies receiver profile and real web state',async()=>{
  const dir=mkdtempSync(path.join(os.tmpdir(),'arena-receiver-game-'));let client;
  const app=await createApp({config:{httpPort:0,mqttPort:0,operatorPin:'12345678',devices},dataDir:dir,bind:'127.0.0.1'});
  try{
    client=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-003',username:'gun-003',password:'test-3',reconnectPeriod:0});
    await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
    const base='irgame/v1/device/gun-003';
    const desired=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('receiver profile not supplied')),2000);client.on('message',(topic,body)=>{if(topic===`${base}/desired`){const m=JSON.parse(body);if(m.hardware_profile===receiverOnlyProfile){clearTimeout(timer);resolve(m);}}});});
    await client.subscribeAsync(`${base}/desired`,{qos:1});
    await client.publishAsync(`${base}/hello`,JSON.stringify({boot_id:'boot'}),{qos:1});
    await client.publishAsync(`${base}/telemetry`,JSON.stringify({...rx,boot_id:'boot',device_time_ms:1000}),{qos:1});
    const message=await desired;assert.equal(message.shooter_id,3);assert.equal(message.team,'B');
    const state=await(await fetch(`http://127.0.0.1:${app.httpServer.address().port}/api/state`)).json();
    assert.equal(state.demo,false);assert.equal(state.players[2].lastIr.relation,'ENEMY');
    assert.deepEqual(state.players.filter(p=>p.connected).map(p=>p.id),['gun-003']);
  }finally{if(client)await client.endAsync(true);await app.close();rmSync(dir,{recursive:true,force:true});}
});
