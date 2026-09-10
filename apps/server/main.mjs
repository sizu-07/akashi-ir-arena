import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,mkdirSync,writeFileSync} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import aedesFactory from 'aedes';
import {WebSocketServer,WebSocket} from 'ws';
import QRCode from 'qrcode';
import {Game} from './game.mjs';
import {hardware} from './hardware.mjs';
import {storage} from './store.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
export async function createApp({config,demo=false,dataDir=path.join(root,'data'),bind='0.0.0.0'}={}){
 const db=storage(dataDir), game=new Game(config.devices,{saved:db.load(),log:e=>db.log(e)});
 const broker=aedesFactory({heartbeatInterval:5000,connectTimeout:5000});
 const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
 const sessions=new Map(),commands=new Map(),attempts=new Map();let owner=null,displaySeen=0,displayReady=false,pairToken=randomBytes(16).toString('hex'),pairExpires=Date.now()+600000;
 const wss=new WebSocketServer({noServer:true,maxPayload:8192});
 broker.authenticate=(client,username,password,cb)=>{const d=config.devices.find(d=>d.id===username);const ok=!!d&&equal(password?.toString(),d.key)&&client.id===d.id;client.deviceId=ok?d.id:null;cb(null,ok);};
 broker.authorizePublish=(client,packet,cb)=>{const prefix=`irgame/v1/device/${client.deviceId}/`;const allowed=['event','hello','telemetry','reported'].map(s=>prefix+s);
   cb(!packet.retain&&packet.payload.length<=4096&&allowed.includes(packet.topic)?null:Error('publish denied'));};
 broker.authorizeSubscribe=(client,sub,cb)=>{cb(null,[`irgame/v1/device/${client.deviceId}/desired`,`irgame/v1/device/${client.deviceId}/command`].includes(sub.topic)?sub:null);};
 const publish=(id,suffix,payload,retain=false)=>broker.publish({topic:`irgame/v1/device/${id}/${suffix}`,payload:Buffer.from(JSON.stringify(payload)),qos:1,retain},err=>{if(err)console.error('MQTT publish:',err.message);});
 function desired(p){publish(p.id,'desired',{schema_version:1,hardware_profile:hardware.profile,damage_feedback:p.damageFeedback,game_id:game.s.id,game_generation:game.s.generation,server_time_ms:Date.now(),lease_ms:3000,phase:game.s.phase,armed:p.armed,hp:p.hp,ammo:p.ammo,team:p.team,shooter_id:p.shooterId,rules:game.s.rules,reload_until:p.reloadUntil,reload_resume_ms:p.reloadRemaining??0,start_at:game.s.startAt??0,start_committed:!!game.s.startCommitted,command_id:game.s.commandId??'',media:game.s.media},true);}
 function sync(){for(const p of game.s.players)desired(p);}
 broker.on('publish',(packet,client)=>{if(!client)return;try{const id=client.deviceId,m=JSON.parse(packet.payload.toString()),suffix=packet.topic.split('/').at(-1);
   if(suffix==='hello'){game.hello(id,m.boot_id);desired(game.player(id));}
   else if(suffix==='telemetry'){if(m.boot_id!==game.player(id).bootId)return;game.heartbeat(id,m);publish(id,'command',{type:'time_sync',echo:m.device_time_ms,server_time_ms:Date.now()});}
   else if(suffix==='event'){const result=game.event(id,m);db.log({at:Date.now(),gameId:game.s.id,type:'device_event_result',deviceId:id,eventType:m.type,messageId:m.message_id,...result});publish(id,'command',{type:'event_result',candidate_message_id:m.message_id,game_id:game.s.id,game_generation:game.s.generation,...result});db.save(game.s);sync();}
 }catch(e){db.log({at:Date.now(),type:'invalid_device_message',reason:e.message});}});
 const mqttServer=net.createServer(broker.handle);
 function session(req){const token=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('arena='))?.slice(6);const s=sessions.get(token);if(s&&s.expires>Date.now()){s.seen=Date.now();return s;}return null;}
 const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>16384)throw Error('本文が大きすぎます');}return JSON.parse(data||'{}');}
 const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.mp4':'video/mp4'};
 const httpServer=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws:; media-src 'self'; object-src 'none'; frame-ancestors 'none'");
   try {const url=new URL(req.url,'http://localhost');
    if(req.method==='POST'&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return reply(res,403,{error:'別サイトからの操作は禁止'});
    if(url.pathname==='/api/login'&&req.method==='POST'){
      const ip=req.socket.remoteAddress,old=attempts.get(ip)??{n:0,until:Date.now()+60000};if(Date.now()>old.until){old.n=0;old.until=Date.now()+60000;}old.n++;attempts.set(ip,old);
      if(old.n>10)return reply(res,429,{error:'1分待ってから再試行してください'});
      const b=await body(req);if(!equal(b.pin,config.operatorPin))return reply(res,403,{error:'PINが違います'});
      const token=randomBytes(24).toString('hex'),s={id:randomBytes(8).toString('hex'),csrf:randomBytes(24).toString('hex'),expires:Date.now()+43200000,seen:Date.now()};sessions.set(token,s);if(!owner)owner=s.id;
      res.setHeader('Set-Cookie',`arena=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return reply(res,200,{csrf:s.csrf,id:s.id});
    }
    if(url.pathname==='/api/session'){const s=session(req);return reply(res,s?200:401,s?{csrf:s.csrf,id:s.id,owner,local:local(req),demo}:{});}
    if(url.pathname==='/api/state'){if(!session(req)&&!local(req))return reply(res,401,{});return reply(res,200,{...game.view(),displayReady:displayReady&&Date.now()-displaySeen<3000,demo,owner});}
    if(url.pathname==='/api/pair.svg'){
      if(!local(req))return reply(res,403,{});const addresses=Object.values(os.networkInterfaces()).flat().filter(a=>a.family==='IPv4'&&!a.internal);const host=addresses[0]?.address??'127.0.0.1';
      if(Date.now()>pairExpires){pairToken=randomBytes(16).toString('hex');pairExpires=Date.now()+600000;}
      res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'no-store'});return res.end(await QRCode.toString(`http://${host}:${httpServer.address().port}/?pair=${pairToken}`,{type:'svg'}));
    }
    if(url.pathname.startsWith('/api/')){
      const s=session(req);if(!s)return reply(res,401,{error:'ログインしてください'});
      if(url.pathname==='/api/export.csv'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="arena-events.csv"'});return res.end(db.csv());}
      if(req.method!=='POST')return reply(res,404,{});
      if(!equal(req.headers['x-csrf-token'],s.csrf))return reply(res,403,{error:'再ログインが必要です'});
      const b=await body(req);
      if(url.pathname==='/api/takeover'){owner=s.id;db.log({at:Date.now(),type:'operator_takeover',operator:s.id});return reply(res,200,{ok:true});}
      if(owner!==s.id)return reply(res,403,{error:'閲覧専用です。操作権を取得してください'});
      if(url.pathname==='/api/provision'){
        if(!local(req))return reply(res,403,{error:'秘密鍵の設定はメインPCで行ってください'});
        if(typeof b.ssid!=='string'||!b.ssid.length||b.ssid.length>32||typeof b.password!=='string'||b.password.length<8||b.password.length>63||typeof b.host!=='string'||!/^[\w.-]{1,100}$/.test(b.host))throw Error('SSID・WPA2パスワード・PCのIPv4を確認してください');
        mkdirSync(path.join(root,'config/provision'),{recursive:true});for(const d of config.devices)writeFileSync(path.join(root,`config/provision/${d.id}.json`),JSON.stringify({ssid:b.ssid,password:b.password,host:b.host,port:config.mqttPort,id:d.id,key:d.key,hardwareProfile:hardware.profile,bench:false,adcScale:2.0}));return reply(res,200,{ok:true,message:'config/provision に4台分を保存しました'});
      }
      if(url.pathname==='/api/action'){
        if(typeof b.commandId!=='string'||b.commandId.length>80)throw Error('commandIdが必要です');const key=s.id+'/'+b.commandId;if(commands.has(key))return reply(res,200,commands.get(key));
        switch(b.action){
          case 'new':game.reset(b.rules);break;
          case 'start':game.start(displayReady&&Date.now()-displaySeen<3000);break;
          case 'pause':game.pause();break;
          case 'finish':game.finish();break;
          case 'hp':game.correct(b.id,Number(b.hp),b.reason);break;
          case 'media':if(!['score','rules','video','black'].includes(b.mode))throw Error('映像モード不正');if(b.mode==='video'&&!existsSync(path.join(root,'assets/rules.mp4')))throw Error('assets/rules.mp4がありません');if(game.s.phase==='ACTIVE'||game.s.phase==='COUNTDOWN')throw Error('試合中は映像切替できません');game.s.media=b.mode;break;
          case 'demo_hit':if(!demo)throw Error('デモ専用操作');simulators?.hit(b.shooter,b.victim,b.receiver??'rx1');break;
          default:throw Error('未知の操作');
        }
        db.log({at:Date.now(),gameId:game.s.id,type:'operator_action',operator:s.id,action:b.action,reason:b.reason});const result={ok:true,commandId:b.commandId};commands.set(key,result);if(commands.size>2000)commands.delete(commands.keys().next().value);db.save(game.s);sync();return reply(res,200,result);
      }return reply(res,404,{});
    }
    const files={'/':'apps/web/index.html','/display':'apps/web/display.html','/style.css':'apps/web/style.css','/app.js':'apps/web/app.js','/display.js':'apps/web/display.js','/rules-content.js':'apps/web/rules-content.js','/rules.mp4':'assets/rules.mp4'};
    if(url.pathname==='/display'&&!local(req))return reply(res,403,{error:'投影画面はメインPCのlocalhostで開いてください'});
    const rel=files[url.pathname];if(!rel||!existsSync(path.join(root,rel)))return reply(res,404,{});const file=readFileSync(path.join(root,rel));
    res.writeHead(200,{'Content-Type':types[path.extname(rel)]??'application/octet-stream','Content-Length':file.length});res.end(file);
   }catch(e){reply(res,400,{error:e.message});}
 });
 httpServer.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');const s=session(req);const display=url.pathname==='/ws/display'&&local(req);
   if(req.headers.origin!==`http://${req.headers.host}`||(!display&&(!s||url.pathname!=='/ws'))){socket.destroy();return;}
   wss.handleUpgrade(req,socket,head,ws=>{ws.operator=s?.id;ws.display=display;ws.on('message',raw=>{try{const m=JSON.parse(raw);if(display&&m.type==='ready'){displayReady=!!m.ready;displaySeen=Date.now();}if(s)s.seen=Date.now();}catch{}});});
 });
 await Promise.all([new Promise(r=>httpServer.listen(config.httpPort,bind,r)),new Promise(r=>mqttServer.listen(config.mqttPort,bind,r))]);
 let simulators=null;if(demo){const {simulate}=await import('./simulator.mjs');simulators=await simulate(config.devices,mqttServer.address().port);}
 let count=0;const timer=setInterval(()=>{game.tick();if(game.s.phase==='COUNTDOWN'&&(!displayReady||Date.now()-displaySeen>3000))game.pause('投影画面切断');
   const state={...game.view(),owner,displayReady:displayReady&&Date.now()-displaySeen<3000,demo};
   for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>100000){ws.close();continue;}ws.send(JSON.stringify(state));}
   if(++count%4===0){sync();db.save(game.s);}if(count%240===0){for(const [k,s] of sessions)if(s.expires<Date.now())sessions.delete(k);}
 },250);
 return {game,broker,httpServer,mqttServer,async close(){clearInterval(timer);await simulators?.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));await new Promise(r=>broker.close(r));await new Promise(r=>mqttServer.close(r));db.save(game.s);}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const demo=process.argv.includes('--demo'),configPath=path.join(root,'config/local.json');
 if(!existsSync(configPath)){console.error('先に node tools/setup.mjs を実行してください');process.exit(1);}
 const config=JSON.parse(readFileSync(configPath,'utf8'));const app=await createApp({config,demo,dataDir:path.join(root,demo?'data/demo':'data/live')});
 console.log(`赤外線対戦 ${demo?'[シミュレーター／実機を接続しない]':'[実機モード]'}\n運営: http://localhost:${config.httpPort}/\n投影: http://localhost:${config.httpPort}/display\nPIN: config/local.json を参照`);
 for(const items of Object.values(os.networkInterfaces()))for(const a of items??[])if(a.family==='IPv4'&&!a.internal)console.log(`タブレット接続候補: http://${a.address}:${config.httpPort}/`);
 let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;app.game.pause('server_shutdown');await app.close();process.exit(0);});
}
