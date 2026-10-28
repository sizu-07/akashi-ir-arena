import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFileSync,existsSync,mkdirSync,writeFileSync,statSync,createReadStream} from 'node:fs';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {spawn} from 'node:child_process';
import aedesFactory from 'aedes';
import {WebSocketServer,WebSocket} from 'ws';
import QRCode from 'qrcode';
import {Game} from './game.mjs';
import {Diagnostics} from './diagnostics.mjs';
import {hardware,legacyMotorDemo,receiverOnlyGame,receiverOnlyProfile} from './hardware.mjs';
import {storage} from './store.mjs';
import {createTicketBridge} from './ticket-bridge.mjs';
import {availableEffects,effectNames} from './sounds.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
// ナレーション付きのルール説明動画（tools/intro-video で生成）があれば優先し、なければ従来のスライド動画を使う。
const rulesVideo=()=>existsSync(path.join(root,'assets/rules-intro.webm'))?'assets/rules-intro.webm':'assets/rules.webm';
const openBrowser=(url)=>{
 try{
  const command=process.platform==='win32'
   ? ['rundll32.exe',['url.dll,FileProtocolHandler',url]]
   : process.platform==='darwin'?['open',[url]]:['xdg-open',[url]];
  const child=spawn(command[0],command[1],{detached:true,stdio:'ignore'});child.unref();
 }catch(error){console.warn(`ブラウザを自動で開けませんでした。手動で開いてください: ${url} (${error.message})`);}
};
const listenServer=(server,port,bind)=>new Promise((resolve,reject)=>{
 const cleanup=()=>{server.off('error',failed);server.off('listening',listening);};
 const failed=error=>{cleanup();reject(error);};
 const listening=()=>{cleanup();resolve();};
 server.once('error',failed);server.once('listening',listening);server.listen(port,bind);
});
const closeServer=server=>server.listening?new Promise(resolve=>server.close(resolve)):Promise.resolve();
export function tabletAddressOf(interfaces){
 const addresses=Object.entries(interfaces).flatMap(([name,items])=>(items??[]).filter(a=>a.family==='IPv4'&&!a.internal).map(a=>({name,address:a.address})));
 return addresses.find(a=>/wi-?fi|wlan|wireless|無線/i.test(a.name))?.address??addresses[0]?.address??'127.0.0.1';
}
export async function detectRunningGameServer(port){
 try {const response=await fetch(`http://127.0.0.1:${port}/api/state`,{signal:AbortSignal.timeout(1000)});if(!response.ok)return null;
  const state=await response.json();return typeof state.demo==='boolean'&&Array.isArray(state.players)?state:null;
 }catch{return null;}
}
export async function createApp({config,demo=false,demoSource,dataDir=path.join(root,'data'),effectsDir=path.join(root,'assets/audio/effects'),bind='0.0.0.0'}={}){
 const db=storage(dataDir),saved=db.load(),game=new Game(config.devices,{saved,allowTestMode:demo,autoAdvanceRounds:!demo,log:e=>db.log(e)});
 const diagnostics=new Diagnostics({log:e=>db.log(e)});
 let simulation=demo&&(demoSource??saved?.demoSource??'simulation')!=='devices',simulators=null,switchingSource=false;
 const simulationKey=randomBytes(24).toString('hex');
 if(demo)game.s.demoSource=simulation?'simulation':'devices';
 const ticketBridge=createTicketBridge({url:demo?undefined:config.ticketServerUrl,apiKey:config.ticketServerApiKey,dataDir,initialRoundId:game.s.ticketRoundId,initialPhase:saved?.phase,log:e=>db.log(e)});
 const broker=aedesFactory({heartbeatInterval:5000,connectTimeout:5000});
 const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
 const local=req=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
 const sessions=new Map(),commands=new Map(),attempts=new Map();let owner=null,preparedTicketGameId=game.s.phase==='LOBBY'&&game.s.ticketRoundId?game.s.id:null,pairToken=randomBytes(16).toString('hex'),pairExpires=Date.now()+600000;
 const demoEventCounts=new Map();
 const wss=new WebSocketServer({noServer:true,maxPayload:8192});
 const displayReady=()=>[...wss.clients].some(ws=>ws.display&&ws.displayReady&&ws.readyState===WebSocket.OPEN);
 broker.authenticate=(client,username,password,cb)=>{const d=config.devices.find(d=>d.id===username);const ok=!!d&&!switchingSource&&equal(password?.toString(),simulation?simulationKey:d.key)&&client.id===(simulation?`sim-${d.id}`:d.id);client.deviceId=ok?d.id:null;client.simulation=simulation;cb(null,ok);};
 broker.authorizePublish=(client,packet,cb)=>{const prefix=`irgame/v1/device/${client.deviceId}/`;const allowed=['event','hello','telemetry','reported'].map(s=>prefix+s);
   cb(!packet.retain&&packet.payload.length<=4096&&allowed.includes(packet.topic)?null:Error('publish denied'));};
 broker.authorizeSubscribe=(client,sub,cb)=>{cb(null,[`irgame/v1/device/${client.deviceId}/desired`,`irgame/v1/device/${client.deviceId}/command`].includes(sub.topic)?sub:null);};
 const publish=(id,suffix,payload,retain=false)=>broker.publish({topic:`irgame/v1/device/${id}/${suffix}`,payload:Buffer.from(JSON.stringify(payload)),qos:1,retain},err=>{if(err)console.error('MQTT publish:',err.message);});
 function desired(p){const diagnostic=diagnostics.state(p.id);publish(p.id,'desired',{schema_version:1,hardware_profile:receiverOnlyGame(p)?receiverOnlyProfile:hardware.profile,damage_feedback:p.damageFeedback,game_id:game.s.id,game_generation:game.s.generation,server_time_ms:Date.now(),lease_ms:3000,phase:game.s.phase,test_mode:game.s.testMode,diagnostic_mode:diagnostics.enabled,diagnostic_hp:diagnostic?.hp??1,diagnostic_respawn_at:diagnostic?.respawnAt??0,battery_override:false,armed:p.armed,hp:p.hp,respawn_at:p.respawnAt??0,round:game.s.round,shooter_id:p.shooterId,rules:game.s.rules,start_at:game.s.startAt??0,start_committed:!!game.s.startCommitted,command_id:game.s.commandId??'',media:game.s.media},true);}
 function sync(){for(const p of game.s.players)desired(p);}
 broker.on('publish',(packet,client)=>{if(!client||switchingSource||client.simulation!==simulation)return;try{const id=client.deviceId,m=JSON.parse(packet.payload.toString()),suffix=packet.topic.split('/').at(-1);
   if(suffix==='hello'){game.hello(id,m.boot_id);desired(game.player(id));}
   else if(suffix==='telemetry'){if(m.boot_id!==game.player(id).bootId)return;game.heartbeat(id,m);publish(id,'command',{type:'time_sync',echo:m.device_time_ms,server_time_ms:Date.now()});}
   else if(suffix==='event'){
     if(m.type==='diagnostic_shot'||m.type==='diagnostic_hit'){
       const result=diagnostics.receive(game,id,m);
       if(!result.ok)db.log({at:Date.now(),gameId:game.s.id,type:'diagnostic_event_rejected',deviceId:id,reason:result.reason});
       if(result.changed)sync();
       return;
     }
     const player=game.player(id);
     if(demo&&!simulation&&['motor_demo_shot','motor_demo_hit','motor_demo_defeat','motor_demo_revive'].includes(m.type)&&legacyMotorDemo(player)){
       if(m.boot_id!==player.bootId||!Number.isSafeInteger(m.count)||m.count<1)return;
       let seen=demoEventCounts.get(id);
       if(!seen||seen.bootId!==player.bootId){seen={bootId:player.bootId,motor_demo_shot:0,motor_demo_hit:0,motor_demo_defeat:0,motor_demo_revive:0};demoEventCounts.set(id,seen);}
       if(m.count<=seen[m.type])return;
       seen[m.type]=m.count;
       if(m.type==='motor_demo_shot')player.demoShots=m.count;
       else if(m.type==='motor_demo_hit')player.demoHits=m.count;
       else if(m.type==='motor_demo_defeat')player.demoDefeats=m.count;
       else player.demoRevives=m.count;
       game.record(m.type,{deviceId:id,count:m.count});db.save(game.s);
     }else{
       const result=game.event(id,m);db.log({at:Date.now(),gameId:game.s.id,type:'device_event_result',deviceId:id,eventType:m.type,messageId:m.message_id,...result});publish(id,'command',{type:'event_result',candidate_message_id:m.message_id,game_id:game.s.id,game_generation:game.s.generation,...result});db.save(game.s);sync();
     }
   }
 }catch(e){db.log({at:Date.now(),type:'invalid_device_message',reason:e.message});}});
 const mqttServer=net.createServer(broker.handle);
 function session(req){const token=(req.headers.cookie??'').split(';').map(s=>s.trim()).find(s=>s.startsWith('arena='))?.slice(6);const s=sessions.get(token);if(s&&s.expires>Date.now()){s.seen=Date.now();return s;}return null;}
 const reply=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));};
 const soundFiles=()=>Object.fromEntries(Object.entries(availableEffects(effectsDir)).map(([kind,entry])=>[kind,entry.url]));
 let checkingTicketMembers=false;
 async function applyTicketMembers(){
   const names=await ticketBridge.loadPlayerNicknames();
   if(game.s.phase!=='LOBBY')return false;
   game.setPlayerNames(names);
   game.s.ticketRoundId=ticketBridge.currentRoundId;
   preparedTicketGameId=game.s.id;
   db.save(game.s);sync();
   return true;
 }
 async function checkTicketMembers(){
   if(!ticketBridge.enabled||checkingTicketMembers||game.s.phase!=='LOBBY'||preparedTicketGameId===game.s.id)return;
   checkingTicketMembers=true;
   try{await applyTicketMembers();}catch{/* Registration or check-in may still be in progress. */}
   finally{checkingTicketMembers=false;}
 }
 async function body(req){let data='';for await(const chunk of req){data+=chunk;if(data.length>16384)throw Error('本文が大きすぎます');}return JSON.parse(data||'{}');}
 const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav','.ttf':'font/ttf'};
 const httpServer=http.createServer(async(req,res)=>{res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
   res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws:; media-src 'self'; object-src 'none'; frame-ancestors 'none'");
   try {const url=new URL(req.url,'http://localhost');
    if(req.method==='POST'&&req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`)return reply(res,403,{error:'別サイトからの操作は禁止'});
    if(url.pathname==='/api/ticket-links'&&req.method==='GET'){
      if(!config.ticketServerUrl)return reply(res,503,{error:'公開整理券サーバーが未設定です'});
      const ticketBase=new URL(config.ticketServerUrl),gameOrigin=`http://${req.headers.host}`;
      const operator=new URL('/operator',ticketBase);operator.searchParams.set('game',`${gameOrigin}/`);
      return reply(res,200,{operator:operator.href,register:new URL('/register',ticketBase).href,scanner:new URL('/scanner',ticketBase).href});
    }
    if(url.pathname==='/api/login'&&req.method==='POST'){
      const ip=req.socket.remoteAddress,old=attempts.get(ip)??{n:0,until:Date.now()+60000};if(Date.now()>old.until){old.n=0;old.until=Date.now()+60000;}old.n++;attempts.set(ip,old);
      if(old.n>10)return reply(res,429,{error:'1分待ってから再試行してください'});
      const b=await body(req);if(!equal(b.pin,config.operatorPin))return reply(res,403,{error:'PINが違います'});
      const token=randomBytes(24).toString('hex'),s={id:randomBytes(8).toString('hex'),csrf:randomBytes(24).toString('hex'),expires:Date.now()+43200000,seen:Date.now()};sessions.set(token,s);if(!owner)owner=s.id;
      res.setHeader('Set-Cookie',`arena=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200`);return reply(res,200,{csrf:s.csrf,id:s.id});
    }
    if(url.pathname==='/api/session'){const s=session(req);return reply(res,s?200:401,s?{csrf:s.csrf,id:s.id,owner,local:local(req),demo}:{});}
    if(url.pathname==='/api/state'){if(!session(req)&&!local(req))return reply(res,401,{});return reply(res,200,{...game.view(),soundFiles:soundFiles(),displayReady:displayReady(),demo,simulation,owner,diagnostics:diagnostics.view(),ticketBridge:{enabled:ticketBridge.enabled,connected:ticketBridge.connected,pending:ticketBridge.pending,membersLoaded:preparedTicketGameId===game.s.id}});}
    if(url.pathname==='/api/pair-info'){
      if(!local(req))return reply(res,403,{});
      return reply(res,200,{url:`http://${tabletAddressOf(os.networkInterfaces())}:${httpServer.address().port}/`});
    }
    if(url.pathname==='/api/pair.svg'){
      if(!local(req))return reply(res,403,{});const host=tabletAddressOf(os.networkInterfaces());
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
        mkdirSync(path.join(root,'config/provision'),{recursive:true});for(const d of config.devices)writeFileSync(path.join(root,`config/provision/${d.id}.json`),JSON.stringify({ssid:b.ssid,password:b.password,host:b.host,port:config.mqttPort,id:d.id,key:d.key,hardwareProfile:hardware.profile,bench:false,adcScale:2.0}));return reply(res,200,{ok:true,message:'config/provision に4台分を保存しました。各銃へUSBで初回登録してください'});
      }
      if(url.pathname==='/api/action'){
        if(switchingSource)throw Error('確認対象を切り替えています。完了後に操作してください');
        if(typeof b.commandId!=='string'||b.commandId.length>80)throw Error('commandIdが必要です');const key=s.id+'/'+b.commandId;if(commands.has(key))return reply(res,200,commands.get(key));
        let operation={};
        switch(b.action){
          case 'demo_source':{
            if(!demo)throw Error('デモ専用操作');
            if(!['LOBBY','FINISHED'].includes(game.s.phase)&&!(game.s.phase==='INTERMISSION'&&game.s.testMode))throw Error('確認対象は待機中・途中経過・終了後だけ変更できます');
            if(!['simulation','devices'].includes(b.source))throw Error('確認対象を選択してください');
            if(simulation===(b.source==='simulation'))break;
            switchingSource=true;
            try{
              game.reset(game.s.rules);sync();
              await simulators?.close();simulators=null;
              await Promise.all(Object.values(broker.clients).map(client=>new Promise(resolve=>client.close(resolve))));
              const names=game.s.players.map(p=>p.name);
              game.s.players=new Game(config.devices).s.players.map((p,i)=>({...p,name:names[i]}));
              demoEventCounts.clear();simulation=b.source==='simulation';game.s.demoSource=b.source;
            }finally{switchingSource=false;}
            if(simulation)simulators=await startSimulation();
            operation={notice:simulation?'仮想端末4台で確認します。':'接続した実機で確認します。端末の再接続を待ってください。'};
            break;
          }
          case 'new':if(diagnostics.enabled)throw Error('一時診断を終了してから次の試合を準備してください');game.reset();break;
          case 'sync_ticket_members':{
            if(game.s.phase!=='LOBBY')throw Error('整理券メンバーは新しい試合の待機中だけ反映できます');
            if(!ticketBridge.enabled)throw Error('公開整理券サーバーが未設定です');
            await applyTicketMembers();
            operation={notice:`整理券メンバーを反映しました: ${game.s.players.map(player=>player.name).join(' / ')}`};
            break;
          }
          case 'start':{
            if(diagnostics.enabled)throw Error('一時診断を終了してからゲームを開始・再開してください');
            if(!demo&&(b.testMode===true||game.s.testMode))throw Error('動作確認は「起動_デモ.cmd」で実行してください');
            const testMode=game.s.phase==='PAUSED'?game.s.testMode:b.testMode===true;
            if(demo&&!simulation&&!testMode)throw Error('デモ版の実機確認では「接続済み端末だけで動作確認」を選択してください');
            if(!testMode&&game.s.phase==='LOBBY'&&ticketBridge.enabled&&preparedTicketGameId!==game.s.id)await applyTicketMembers();
            game.start(displayReady(),{testMode});break;
          }
          case 'pause':game.pause();break;
          case 'finish':if(diagnostics.enabled)diagnostics.end(game);game.finish('operator');break;
          case 'diagnostic_on':{
            if(simulation)throw Error('仮想端末では一時診断を使用できません');
            diagnostics.begin(game);operation={notice:'一時診断を開始しました。試合の得点には加算されません。'};break;
          }
          case 'diagnostic_off':diagnostics.end(game);operation={notice:'一時診断を終了しました。停止中の試合は確認後に手動で再開してください。'};break;
          case 'demo_end_round':if(!demo)throw Error('デモ専用操作');if(diagnostics.enabled)throw Error('一時診断を終了してからゲームを進めてください');game.endRound('demo_skip');break;
          case 'media':if(b.mode==='video'&&!existsSync(path.join(root,rulesVideo())))throw Error('ルール説明動画がありません');game.setMedia(b.mode);break;
          case 'video':if(!existsSync(path.join(root,rulesVideo())))throw Error('ルール説明動画がありません');game.controlVideo(b.operation);break;
          case 'demo_hit':if(!simulation)throw Error('仮想端末専用操作');simulators?.hit(b.shooter,b.victim,b.receiver??'rx1');break;
          case 'motor_demo_hit':
          case 'motor_demo_defeat':
          case 'motor_demo_revive':{
            if(!demo||simulation)throw Error('デモ版の実機モーター確認専用操作');
            const player=game.player(b.id);
            if(!player.connected||!legacyMotorDemo(player))
              throw Error('対象端末は実機モーターデモに接続していません');
            if(b.action!=='motor_demo_hit'&&!['legacy-motor-demo-3','legacy-motor-demo-4','legacy-motor-demo-5','legacy-motor-demo-6'].includes(player.firmwareVersion))
              throw Error('この振動は端末の更新後に使用できます');
            publish(player.id,'command',{type:b.action,command_id:b.commandId,server_time_ms:Date.now()});
            const name={motor_demo_hit:'被弾',motor_demo_defeat:'HP 0',motor_demo_revive:'復活'}[b.action];
            operation={notice:`${player.name}へ${name}振動を送信しました。端末の状態を確認してください。`};
            break;
          }
          default:throw Error('未知の操作');
        }
        db.log({at:Date.now(),gameId:game.s.id,type:'operator_action',operator:s.id,action:b.action,reason:b.reason});const result={ok:true,commandId:b.commandId,...operation};commands.set(key,result);if(commands.size>2000)commands.delete(commands.keys().next().value);db.save(game.s);sync();return reply(res,200,result);
      }return reply(res,404,{});
    }
    if(['/tickets','/tickets/register','/tickets/scanner'].includes(url.pathname)){
      const gameOrigin=`http://${req.headers.host}`;
      if(!config.ticketServerUrl)return reply(res,503,{error:'公開整理券サーバーが未設定です。config/local.json の ticketServerUrl を設定してください'});
      const ticketBase=new URL(config.ticketServerUrl);
      const destinations={'/tickets':'/operator','/tickets/register':'/register','/tickets/scanner':'/scanner'};
      const target=new URL(destinations[url.pathname],ticketBase);
      if(url.pathname==='/tickets')target.searchParams.set('game',`${gameOrigin}/`);
      res.writeHead(302,{Location:target.href});return res.end();
    }
    const effectMatch=/^\/effects\/([a-z-]+)\.(mp3|wav)$/.exec(url.pathname);
    if(effectMatch&&effectNames.includes(effectMatch[1])){
      const selected=availableEffects(effectsDir)[effectMatch[1]];
      if(!selected||path.basename(selected.file)!==`${effectMatch[1]}.${effectMatch[2]}`)return reply(res,404,{});
      const file=readFileSync(selected.file);
      res.writeHead(200,{'Content-Type':types[`.${effectMatch[2]}`],'Content-Length':file.length,'Cache-Control':'no-store'});
      return res.end(file);
    }
    const files={'/':'apps/web/index.html','/display':'apps/web/display.html','/style.css':'apps/web/style.css','/app.js':'apps/web/app.js','/display.js':'apps/web/display.js','/rules-content.js':'apps/web/rules-content.js','/rules.webm':rulesVideo(),'/countdown.wav':'assets/audio/countdown/countdown.wav','/bgm.mp3':'assets/audio/bgm/bgm.mp3'};
    files['/battery-status.js']='apps/web/battery-status.js';
    files['/operation-status.js']='apps/web/operation-status.js';
    files['/operator-shared.css']='apps/ticket-web/operator-shared.css';
    files['/display.css']='apps/web/display.css';
    files['/display-icon.svg']='apps/web/display-icon.svg';
    for(const font of ['Anton-Regular.ttf','BarlowCondensed-Bold.ttf','NotoSansJP.ttf'])files[`/fonts/${font}`]=`apps/web/fonts/${font}`;
    if(url.pathname==='/display'&&!local(req))return reply(res,403,{error:'投影画面はメインPCのlocalhostで開いてください'});
    const rel=files[url.pathname];if(!rel||!existsSync(path.join(root,rel)))return reply(res,404,{});
    if(path.extname(rel)==='.webm'){
     // 大きな動画は途中位置からの再生・再開ができるよう Range 要求に応える。
     const size=statSync(path.join(root,rel)).size,range=/^bytes=(\d*)-(\d*)$/.exec(req.headers.range??'');
     let start=0,end=size-1;
     if(range){start=range[1]?Number(range[1]):Math.max(0,size-Number(range[2]));end=range[1]&&range[2]?Math.min(Number(range[2]),size-1):size-1;
      if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}}
     res.writeHead(range?206:200,{'Content-Type':types['.webm'],'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
     return createReadStream(path.join(root,rel),{start,end}).pipe(res);
    }
    const file=readFileSync(path.join(root,rel));
    res.writeHead(200,{'Content-Type':types[path.extname(rel)]??'application/octet-stream','Content-Length':file.length});res.end(file);
   }catch(e){reply(res,400,{error:e.message});}
 });
 httpServer.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');const s=session(req);const display=url.pathname==='/ws/display'&&local(req);
   if(req.headers.origin!==`http://${req.headers.host}`||(!display&&(!s||url.pathname!=='/ws'))){socket.destroy();return;}
   wss.handleUpgrade(req,socket,head,ws=>{ws.operator=s?.id;ws.display=display;ws.displayReady=false;ws.on('message',raw=>{try{const m=JSON.parse(raw);if(display&&m.type==='ready')ws.displayReady=!!m.ready;if(s)s.seen=Date.now();}catch{}});});
 });
 try {await listenServer(httpServer,config.httpPort,bind);await listenServer(mqttServer,config.mqttPort,bind);}
 catch(error){await closeServer(httpServer);await closeServer(mqttServer);await new Promise(resolve=>broker.close(resolve));throw error;}
 async function startSimulation(){const {simulate}=await import('./simulator.mjs');return simulate(config.devices.map(d=>({...d,clientId:`sim-${d.id}`,key:simulationKey})),mqttServer.address().port);}
 if(simulation)simulators=await startSimulation();
 let count=0,lastSavedPhase=game.s.phase;const timer=setInterval(()=>{game.tick(displayReady());if(diagnostics.tick())sync();if(game.s.phase==='COUNTDOWN'&&!displayReady())game.pause('投影画面切断');
   const ticketStartedBefore=game.s.ticketStarted,ticketPausedBefore=game.s.ticketPaused;
   ticketBridge.observe(game.s);
   if(game.s.phase!==lastSavedPhase||game.s.ticketStarted!==ticketStartedBefore||game.s.ticketPaused!==ticketPausedBefore){db.save(game.s);lastSavedPhase=game.s.phase;}
   const state={...game.view(),soundFiles:soundFiles(),owner,displayReady:displayReady(),demo,simulation,diagnostics:diagnostics.view(),ticketBridge:{enabled:ticketBridge.enabled,connected:ticketBridge.connected,pending:ticketBridge.pending,membersLoaded:preparedTicketGameId===game.s.id}};
   for(const ws of wss.clients)if(ws.readyState===WebSocket.OPEN){if(ws.bufferedAmount>100000){ws.close();continue;}ws.send(JSON.stringify(state));}
   if(++count%4===0){sync();db.save(game.s);}if(count%8===0)void checkTicketMembers();if(count%240===0){for(const [k,s] of sessions)if(s.expires<Date.now())sessions.delete(k);}
 },250);
 return {game,broker,httpServer,mqttServer,ticketBridge,async close(){clearInterval(timer);await simulators?.close();await ticketBridge.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>httpServer.close(r));await new Promise(r=>broker.close(r));await new Promise(r=>mqttServer.close(r));db.save(game.s);}};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const demo=process.argv.includes('--demo'),shouldOpen=process.argv.includes('--open'),configPath=path.join(root,'config/local.json');
 if(!existsSync(configPath)){console.error('先に node tools/setup.mjs を実行してください');process.exit(1);}
 const config=JSON.parse(readFileSync(configPath,'utf8')),existing=await detectRunningGameServer(config.httpPort);let app=null;
 if(existing){
  if(existing.demo!==demo){console.error(`${config.httpPort}番ポートでは赤外線対戦サーバーが${existing.demo?'デモ':'本番'}モードで起動済みです。先にその起動画面を閉じてください。`);process.exitCode=1;}
  else {console.log(`赤外線対戦サーバーはすでに起動しています。既存のサーバーを使用します。\n運営: http://localhost:${config.httpPort}/\n投影: http://localhost:${config.httpPort}/display`);if(shouldOpen)openBrowser(`http://localhost:${config.httpPort}/`);}
 }else try {
  app=await createApp({config,demo,dataDir:path.join(root,demo?'data/demo':'data/live')});
  console.log(`赤外線対戦 ${demo?'[デモ／仮想端末・実機確認を画面で切替]':'[本番／実機4台の通常試合]'}\n運営: http://localhost:${config.httpPort}/\n投影: http://localhost:${config.httpPort}/display\nPIN: config/local.json を参照`);
  for(const items of Object.values(os.networkInterfaces()))for(const a of items??[])if(a.family==='IPv4'&&!a.internal)console.log(`タブレット接続候補: http://${a.address}:${config.httpPort}/`);
  if(shouldOpen)openBrowser(`http://localhost:${config.httpPort}/`);
 }catch(error){
  if(error.code==='EADDRINUSE')console.error(`${error.port}番ポートは別のアプリケーションが使用中です。使用中のアプリケーションを終了するか、config/local.json のポート番号を変更してください。`);
  else console.error(`サーバーを起動できません: ${error.message}`);
  process.exitCode=1;
 }
 if(app){let stopping=false;for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;app.game.pause('server_shutdown');await app.close();process.exit(0);});}
}
