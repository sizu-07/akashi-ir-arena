import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';import http from 'node:http';import net from 'node:net';import mqtt from 'mqtt';import WebSocket from 'ws';import {createApp,detectRunningGameServer} from '../apps/server/main.mjs';
test('HTTP authentication, operator lease, CSRF, MQTT auth and ACL',async()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'arena-test-'));const config={httpPort:0,mqttPort:0,operatorPin:'12345678',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`test-key-${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n}))};const app=await createApp({config,dataDir:dir,bind:'127.0.0.1'});const base=`http://127.0.0.1:${app.httpServer.address().port}`;let client;
 try {const login=async()=>{const r=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:config.operatorPin})});assert.equal(r.status,200);return {cookie:r.headers.get('set-cookie').split(';')[0],...await r.json()};};const a=await login(),b=await login();
 const act=(s,extra={})=>fetch(base+'/api/action',{method:'POST',headers:{'Content-Type':'application/json',Cookie:s.cookie,'X-CSRF-Token':s.csrf},body:JSON.stringify({commandId:'one',action:'new',...extra})});
 assert.equal((await act(a)).status,200);const game=app.game.s.id;assert.equal((await act(a)).status,200);assert.equal(app.game.s.id,game);assert.equal((await act(b)).status,403);assert.equal((await act({...a,csrf:'wrong'})).status,403);
 const unauth=await fetch(base+'/api/action',{method:'POST',body:'{}'});assert.equal(unauth.status,401);
 client=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-001',username:'gun-001',password:'test-key-1',reconnectPeriod:0});await new Promise((r,j)=>{client.once('connect',r);client.once('error',j);});
 await assert.rejects(client.subscribeAsync('irgame/v1/device/gun-002/desired',{qos:1}),e=>e.code===128);
 const bad=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-002',username:'gun-002',password:'wrong',reconnectPeriod:0});await new Promise(resolve=>{bad.once('error',()=>{bad.end(true);resolve();});});
 }finally{if(client)await client.endAsync(true);await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('実機モーターデモの被弾操作は接続した診断端末へMQTT指示を送り、試合状態を変えない',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'arena-motor-demo-'));
 const config={httpPort:0,mqttPort:0,operatorPin:'12345678',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`test-key-${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n}))};
 const app=await createApp({config,dataDir:dir,bind:'127.0.0.1'});
 const base=`http://127.0.0.1:${app.httpServer.address().port}`;
 let client;
 try{
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:config.operatorPin})});
  const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const send=()=>fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({commandId:'hit-test-1',action:'motor_demo_hit',id:'gun-001'})});
  assert.equal((await send()).status,400);
  client=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-001',username:'gun-001',password:'test-key-1',reconnectPeriod:0});
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  const topic='irgame/v1/device/gun-001';
  await client.subscribeAsync(`${topic}/command`,{qos:1});
  await client.publishAsync(`${topic}/hello`,JSON.stringify({boot_id:'motor-test-boot'}),{qos:1});
  await client.publishAsync(`${topic}/telemetry`,JSON.stringify({boot_id:'motor-test-boot',hardware_profile:'xiao-s3-plus-3rx-6led-motor-trigger',firmware_version:'legacy-motor-demo-5',hardware_ready:false,bench:true,device_time_ms:1,syncRtt:7,demo_shots:1,demo_hits:0,demo_defeats:0,demo_revives:0,motor_pwm_limit:220,motor_run_limit:180,motor_startup_ms:60,motor_hw_duty:150,motor_duty:150,motor_pattern:'SHOT',motor_queue_depth:1,motor_dropped_commands:0,reset_reason:9,demo_countdown_missed:0}),{qos:1});
  const before={phase:app.game.s.phase,hp:app.game.player('gun-001').hp};
  assert.equal(app.game.player('gun-001').demoShots,1);
  assert.equal(app.game.player('gun-001').motorPwmLimit,220);
  assert.equal(app.game.player('gun-001').motorRunLimit,180);
  assert.equal(app.game.player('gun-001').motorStartupMs,60);
  assert.equal(app.game.player('gun-001').motorDuty,150);
  assert.equal(app.game.player('gun-001').motorHwDuty,150);
  assert.equal(app.game.player('gun-001').motorQueueDepth,1);
  assert.equal(app.game.player('gun-001').resetReason,9);
  const command=new Promise((resolve,reject)=>{
   const timer=setTimeout(()=>reject(Error('被弾指示が届きません')),2000);
   client.on('message',function onMessage(name,raw){const body=JSON.parse(raw);if(name===`${topic}/command`&&body.type==='motor_demo_hit'){clearTimeout(timer);client.off('message',onMessage);resolve(body);}});
  });
  assert.equal((await send()).status,200);
  assert.deepEqual((await command).command_id,'hit-test-1');
  for(const type of ['motor_demo_defeat','motor_demo_revive']){
   const next=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error(`${type} 指示が届きません`)),2000);
    client.on('message',function onMessage(name,raw){const body=JSON.parse(raw);if(name===`${topic}/command`&&body.type===type){clearTimeout(timer);client.off('message',onMessage);resolve(body);}});
   });
   const response=await fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({commandId:`${type}-test`,action:type,id:'gun-001'})});
   assert.equal(response.status,200);
   assert.equal((await next).command_id,`${type}-test`);
  }
  assert.deepEqual({phase:app.game.s.phase,hp:app.game.player('gun-001').hp},before);
  const shot={type:'motor_demo_shot',boot_id:'motor-test-boot',count:2};
  const hit={type:'motor_demo_hit',boot_id:'motor-test-boot',count:1};
  await client.publishAsync(`${topic}/event`,JSON.stringify(shot),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify(shot),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify(hit),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify({...hit,boot_id:'wrong',count:2}),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify({type:'motor_demo_defeat',boot_id:'motor-test-boot',count:1}),{qos:1});
  await client.publishAsync(`${topic}/event`,JSON.stringify({type:'motor_demo_revive',boot_id:'motor-test-boot',count:1}),{qos:1});
  assert.deepEqual(app.game.view().soundEvents.map(event=>event.kind),['shot','hit','defeat','revive']);
  assert.equal(app.game.player('gun-001').demoShots,2);
  assert.equal(app.game.player('gun-001').demoHits,1);
  assert.equal(app.game.player('gun-001').demoDefeats,1);
  assert.equal(app.game.player('gun-001').demoRevives,1);
  assert.deepEqual({phase:app.game.s.phase,hp:app.game.player('gun-001').hp},before);
 }finally{if(client)await client.endAsync(true);await app.close();rmSync(dir,{recursive:true,force:true});}
});

test('整理券連携中でも接続済み診断端末1台で動作確認を開始できる',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'arena-partial-test-'));
 const ticketEvents=[];
 const ticketServer=http.createServer((req,res)=>{if(req.url==='/api/game/events')ticketEvents.push(req.url);res.writeHead(200,{'Content-Type':'application/json'});res.end('{"ok":true}');});
 await new Promise(resolve=>ticketServer.listen(0,'127.0.0.1',resolve));
 const config={httpPort:0,mqttPort:0,operatorPin:'12345678',ticketServerUrl:`http://127.0.0.1:${ticketServer.address().port}`,ticketServerApiKey:'test-key',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`test-key-${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n}))};
 let app,client,display,telemetryTimer;
 try{
  app=await createApp({config,dataDir:dir,bind:'127.0.0.1'});
  const base=`http://127.0.0.1:${app.httpServer.address().port}`;
  const login=await fetch(`${base}/api/login`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:config.operatorPin})});
  const session=await login.json(),cookie=login.headers.get('set-cookie').split(';')[0];
  const action=async(name,extra={})=>fetch(`${base}/api/action`,{method:'POST',headers:{'Content-Type':'application/json',Cookie:cookie,'X-CSRF-Token':session.csrf},body:JSON.stringify({commandId:`${name}-${Date.now()}`,action:name,...extra})});
  display=new WebSocket(base.replace('http:','ws:')+'/ws/display',{headers:{Origin:base}});
  await new Promise((resolve,reject)=>{display.once('open',resolve);display.once('error',reject);});
  display.send(JSON.stringify({type:'ready',ready:true}));
  client=mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`,{clientId:'gun-001',username:'gun-001',password:'test-key-1',reconnectPeriod:0});
  await new Promise((resolve,reject)=>{client.once('connect',resolve);client.once('error',reject);});
  const topic='irgame/v1/device/gun-001';
  await client.publishAsync(`${topic}/hello`,JSON.stringify({boot_id:'bench-boot'}),{qos:1});
  const telemetry=()=>client.publish(`${topic}/telemetry`,JSON.stringify({boot_id:'bench-boot',hardware_profile:'xiao-s3-plus-3rx-6led-motor-trigger',firmware_version:'legacy-motor-demo-1',hardware_ready:false,bench:true,device_time_ms:1,syncRtt:7,lowBattery:false}),{qos:1});
  telemetry();telemetryTimer=setInterval(telemetry,700);
  await new Promise(resolve=>setTimeout(resolve,150));
  assert.equal(app.game.player('gun-001').connected,true);
  const start=await action('start',{testMode:true});
  assert.equal(start.status,200,await start.text());
  assert.deepEqual(app.game.s.participantIds,['gun-001']);
  await new Promise((resolve,reject)=>{const deadline=Date.now()+8500;const timer=setInterval(()=>{if(app.game.s.phase==='ACTIVE'){clearInterval(timer);resolve();}else if(app.game.s.phase==='PAUSED'||Date.now()>deadline){clearInterval(timer);reject(Error(`開始に失敗しました: ${app.game.s.phase}`));}},50);});
  assert.equal(app.game.player('gun-001').armed,false);
  assert.equal((await action('finish')).status,200);
  assert.equal(app.game.s.winner,null);
  await new Promise(resolve=>setTimeout(resolve,300));
  assert.deepEqual(ticketEvents,[]);
 }finally{
  if(telemetryTimer)clearInterval(telemetryTimer);
  if(client)await client.endAsync(true);
  if(display)display.close();
  if(app)await app.close();
  await new Promise(resolve=>ticketServer.close(resolve));
  rmSync(dir,{recursive:true,force:true});
 }
});
test('使用中のHTTPポートではEADDRINUSEを呼出元へ返し、途中起動を残さない',async()=>{const occupied=net.createServer();await new Promise(resolve=>occupied.listen(0,'127.0.0.1',resolve));const dir=mkdtempSync(path.join(os.tmpdir(),'arena-port-test-'));const config={httpPort:occupied.address().port,mqttPort:0,operatorPin:'12345678',devices:[]};
 try {await assert.rejects(createApp({config,dataDir:dir,bind:'127.0.0.1'}),error=>error.code==='EADDRINUSE'&&error.port===config.httpPort);}
 finally{await new Promise(resolve=>occupied.close(resolve));rmSync(dir,{recursive:true,force:true});}
});
test('すでに起動しているゲームサーバーのモードを判定できる',async()=>{const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({demo:true,players:[]}));});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 try {const state=await detectRunningGameServer(server.address().port);assert.equal(state.demo,true);}
 finally{await new Promise(resolve=>server.close(resolve));}
});
test('投影画面の接続中はブラウザータイマーが止まってもカウントダウンを継続する',async()=>{const dir=mkdtempSync(path.join(os.tmpdir(),'arena-display-test-'));const config={httpPort:0,mqttPort:0,operatorPin:'12345678',devices:[1,2,3,4].map(n=>({id:`gun-00${n}`,key:`test-key-${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n}))};const app=await createApp({config,demo:true,dataDir:dir,bind:'127.0.0.1'});const base=`http://127.0.0.1:${app.httpServer.address().port}`;const display=new WebSocket(base.replace('http:','ws:')+'/ws/display',{headers:{Origin:base}});
 try {await new Promise((resolve,reject)=>{display.once('open',resolve);display.once('error',reject);});display.send(JSON.stringify({type:'ready',ready:true}));await new Promise(resolve=>setTimeout(resolve,3250));app.game.start(true);await new Promise((resolve,reject)=>{const deadline=Date.now()+8500;const timer=setInterval(()=>{if(app.game.s.phase==='ACTIVE'){clearInterval(timer);resolve();}else if(app.game.s.phase==='PAUSED'||Date.now()>deadline){clearInterval(timer);reject(Error(`開始に失敗しました: ${app.game.s.phase}`));}},50);});assert.equal(app.game.s.phase,'ACTIVE');}
 finally{display.close();await app.close();rmSync(dir,{recursive:true,force:true});}
});
