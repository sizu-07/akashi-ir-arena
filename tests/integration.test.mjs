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
