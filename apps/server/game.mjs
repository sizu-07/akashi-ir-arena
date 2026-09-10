import { randomUUID } from 'node:crypto';
import {hardware,receiverIds,deviceReady} from './hardware.mjs';
export const defaults = Object.freeze({hp:100, damage:25, durationSec:300, magazine:30, fireMs:200, reloadMs:2000, invulnerableMs:300, friendlyFire:false});
export function rulesOf(input={}) {
  const r={...defaults,...input};
  const bounds={hp:[1,1000],damage:[1,1000],durationSec:[10,3600],magazine:[1,200],fireMs:[200,3000],reloadMs:[500,10000],invulnerableMs:[0,3000]};
  for(const [k,[a,b]] of Object.entries(bounds)) if(!Number.isInteger(r[k])||r[k]<a||r[k]>b) throw Error(`${k}: ${a}〜${b}の整数が必要です`);
  if(typeof r.friendlyFire!=='boolean') throw Error('friendlyFireは真偽値');
  return Object.fromEntries([...Object.keys(bounds),'friendlyFire'].map(k=>[k,r[k]]));
}
export class Game {
  constructor(devices,{now=Date.now,log=()=>{},saved=null}={}) {
    this.now=now; this.log=log; this.pending=[]; this.shots=[]; this.seen=new Map(); this.events=saved?.eventNo??0;
    this.s={id:randomUUID(),generation:1,phase:'LOBBY',rules:{...defaults},remainingMs:300000,score:{A:0,B:0},media:'score',winner:null,
      players:devices.map(d=>({id:d.id,name:d.name,team:d.team,shooterId:d.shooterId,hp:100,ammo:30,connected:false,armed:false,lastSeen:0,bootId:null,ack:null,lastShot:-1e15,invUntil:0,reloadUntil:0,rssi:null,battery:null,syncRtt:null}))};
    if(saved?.players?.length===4) {
      this.s={...saved,phase:['ACTIVE','COUNTDOWN','PAUSED'].includes(saved.phase)?'PAUSED':saved.phase,generation:saved.generation+1};
      this.s.players=devices.map(d=>({...saved.players.find(p=>p.id===d.id),...d,key:undefined,connected:false,armed:false,lastSeen:0,ack:null,bootId:null,reloadUntil:0,lastShot:-1e15}));
      this.record('recovery',{phase:this.s.phase});
    }
    for(const p of this.s.players)Object.assign(p,{hardwareProfile:null,hardwareReady:false,firmwareVersion:null,bench:false,lowBattery:false,motorActive:false,rxFrames:{},lastReceiver:null,damageFeedback:null});
  }
  record(type,payload){this.s.eventNo=++this.events;this.log({n:this.events,at:this.now(),gameId:this.s.id,type,...payload});}
  player(id){const p=this.s.players.find(p=>p.id===id);if(!p)throw Error('未登録端末');return p;}
  view(){return structuredClone({...this.s,serverMs:this.now()});}
  reset(rules){if(!['LOBBY','FINISHED'].includes(this.s.phase))throw Error('終了してから新試合を作成してください');
    const r=rulesOf(rules);this.s.id=randomUUID();this.s.generation++;this.s.phase='LOBBY';this.s.rules=r;this.s.remainingMs=r.durationSec*1000;this.s.score={A:0,B:0};this.s.winner=null;this.s.media='score';
    for(const p of this.s.players)Object.assign(p,{hp:r.hp,ammo:r.magazine,armed:false,ack:null,lastShot:-1e15,reloadUntil:0,reloadRemaining:0,deadAt:0,invUntil:0});
    for(const p of this.s.players){p.damageFeedback=null;p.lastReceiver=null;}
    this.shots=[];this.pending=[];this.seen.clear();this.record('new_game',{rules:r});}
  start(displayReady){if(!['LOBBY','PAUSED'].includes(this.s.phase))throw Error('待機・停止中のみ開始できます');
    if(!displayReady)throw Error('投影画面で「表示を準備」を押してください');
    if(this.s.players.some(p=>!p.connected||this.now()-p.lastSeen>2500||p.syncRtt===null||p.syncRtt>400))throw Error('4台の接続・時刻同期を確認してください');
    if(this.s.players.some(p=>!deviceReady(p)))throw Error('4台のv0.6対応・通常モード・電池状態を確認してください');
    this.s.generation++;this.s.phase='COUNTDOWN';this.s.startAt=this.now()+3000;this.s.commandId=randomUUID();this.s.startCommitted=false;this.s.media='score';
    for(const p of this.s.players){p.ack=null;p.armed=false;p.damageFeedback=null;}this.record('countdown',{startAt:this.s.startAt,commandId:this.s.commandId});}
  pause(reason='operator'){if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());
    if(['ACTIVE','COUNTDOWN'].includes(this.s.phase)){this.s.phase='PAUSED';this.s.generation++;this.s.startCommitted=false;for(const p of this.s.players){p.armed=false;if(p.reloadUntil){p.reloadRemaining=Math.max(0,p.reloadUntil-this.now());p.reloadUntil=0;}}this.pending=[];this.record('pause',{reason});}}
  finish(reason='operator'){if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());this.s.phase='FINISHED';this.s.generation++;for(const p of this.s.players)p.armed=false;
    const hp=t=>this.s.players.filter(p=>p.team===t).reduce((a,p)=>a+p.hp,0);const a=this.s.score.A,b=this.s.score.B;this.s.winner=a!==b?(a>b?'A':'B'):(hp('A')===hp('B')?'DRAW':hp('A')>hp('B')?'A':'B');this.pending=[];this.record('finish',{reason,winner:this.s.winner});}
  correct(id,hp,reason){if(!reason?.trim()||!Number.isInteger(hp)||hp<0||hp>this.s.rules.hp)throw Error('補正理由と範囲内のHPが必要です');
    if(this.s.phase!=='PAUSED'&&this.s.phase!=='LOBBY')throw Error('HP補正は待機・一時停止中のみ可能です');const p=this.player(id);const before=p.hp;p.hp=hp;this.record('hp_correction',{deviceId:id,before,after:hp,reason});}
  hello(id,bootId){const p=this.player(id);if(typeof bootId!=='string'||bootId.length>80)throw Error('boot_id不正');
    if(p.bootId!==bootId){p.armed=false;p.syncRtt=null;p.hardwareReady=false;p.hardwareProfile=null;p.damageFeedback=null;if(['ACTIVE','COUNTDOWN'].includes(this.s.phase))this.pause('端末再起動');}p.bootId=bootId;p.connected=true;p.lastSeen=this.now();}
  heartbeat(id,data){const p=this.player(id);p.connected=true;p.lastSeen=this.now();p.battery=Number.isFinite(data.battery)?data.battery:null;p.rssi=data.rssi??null;
    p.syncRtt=Number.isFinite(data.syncRtt)&&data.syncRtt>=0?data.syncRtt:null;
    p.hardwareProfile=typeof data.hardware_profile==='string'?data.hardware_profile.slice(0,80):null;
    p.hardwareReady=data.hardware_ready===true;p.firmwareVersion=typeof data.firmware_version==='string'?data.firmware_version.slice(0,24):null;
    p.bench=data.bench===true;p.lowBattery=data.lowBattery===true;p.motorActive=data.motor_active===true;
    p.rxFrames=Object.fromEntries(receiverIds.map(k=>[k,Number.isSafeInteger(data.rx_frames?.[k])&&data.rx_frames[k]>=0?data.rx_frames[k]:null]));
    if(!deviceReady(p)&&['ACTIVE','COUNTDOWN'].includes(this.s.phase))this.pause(p.lowBattery?'電池低下':'端末構成・机上モードを確認');}
  ack(id,payload){const p=this.player(id);if(this.s.phase==='COUNTDOWN'&&deviceReady(p)&&payload.command_id===this.s.commandId&&payload.result==='ok'){p.ack=this.s.commandId;this.s.startCommitted=this.s.players.every(p=>p.ack===this.s.commandId);}}
  event(id,m){this.tick();const p=this.player(id),t=this.now();
    if(!m||m.device_id!==id||m.boot_id!==p.bootId||typeof m.message_id!=='string'||m.message_id.length>160||!Number.isSafeInteger(m.seq))return {ok:false,reason:'envelope'};
    if(m.game_id!==this.s.id||m.game_generation!==this.s.generation)return {ok:false,reason:'old_game'};
    if(this.seen.has(`${id}/${m.message_id}`))return {ok:false,reason:'duplicate'};this.seen.set(`${id}/${m.message_id}`,t);
    const e=m.payload??{};
    if(m.type==='command_ack'){this.ack(id,e);return {ok:true};}
    if(this.s.phase!=='ACTIVE'||!p.armed||!p.connected||!deviceReady(p))return {ok:false,reason:'not_active'};
    // Bound device time to reception time. Device clock cannot extend the game deadline.
    const at=Number.isFinite(m.server_time_ms)?m.server_time_ms:t;
    if(Math.abs(t-at)>500||at<this.s.startAt||t>=this.s.endAt)return {ok:false,reason:'time_window'};
    if(m.type==='shot_fired'){
      // Allow a shot already in flight just before an opposing lethal hit (bounded 150 ms).
      if(p.hp<=0&&!(p.deadAt&&at<=p.deadAt&&t-p.deadAt<=150))return {ok:false,reason:'dead'};
      if(p.ammo<=0||p.reloadUntil>0||at-p.lastShot<this.s.rules.fireMs-15)return {ok:false,reason:'ammo_or_rate'};
      if(!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255||e.weapon_id!==1)return {ok:false,reason:'weapon'};
      p.ammo--;p.lastShot=at;this.shots.push({shooter:id,seq:e.shot_seq,at,received:t,victims:new Set()});
      this.record('shot',{deviceId:id,seq:e.shot_seq,ammo:p.ammo});this.flushPending();return {ok:true};
    }
    if(m.type==='reload_started'){if(p.hp<=0||p.reloadUntil||p.ammo===this.s.rules.magazine)return {ok:false,reason:'reload_invalid'};p.reloadUntil=t+this.s.rules.reloadMs;return {ok:true};}
    if(m.type==='hit_candidate'){
      if(p.hp<=0)return {ok:false,reason:'dead'};
      const hit={id,m,at,received:t,expires:t+350};const result=this.hit(hit);
      if(result.reason==='await_shot'){if(this.pending.length>=256)return {ok:false,reason:'overflow'};this.pending.push(hit);return {ok:false,reason:'pending'};}return result;
    }return {ok:false,reason:'unknown_type'};
  }
  hit(h){const p=this.player(h.id),e=h.m.payload;const shooter=this.s.players.find(x=>x.shooterId===e.shooter_id);
    if(!shooter||shooter.id===p.id||e.weapon_id!==1||!receiverIds.includes(e.receiver_id)||!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255)return {ok:false,reason:'invalid_ir'};
    if(!this.s.rules.friendlyFire&&shooter.team===p.team)return {ok:false,reason:'friendly'};
    const shot=this.shots.findLast(x=>x.shooter===shooter.id&&x.seq===e.shot_seq&&h.at-x.at>=-150&&h.at-x.at<=500);
    if(!shot)return {ok:false,reason:'await_shot'};
    if(shot.victims.has(p.id))return {ok:false,reason:'duplicate_hit'};
    if(p.hp<=0||h.at<p.invUntil)return {ok:false,reason:'invulnerable_or_dead'};
    shot.victims.add(p.id);const before=p.hp;const damage=Math.min(p.hp,this.s.rules.damage);p.hp-=damage;p.invUntil=h.at+this.s.rules.invulnerableMs;
    if(!p.hp){p.deadAt=h.at;if(shooter.team!==p.team)this.s.score[shooter.team]++;}p.lastReceiver=e.receiver_id;this.record('hit',{deviceId:p.id,shooter:shooter.id,receiverId:e.receiver_id,candidate_message_id:h.m.message_id,before,hp:p.hp,damage});
    p.damageFeedback={id:this.events,at:this.now(),duration_ms:hardware.outputs.motor.pulseMs};
    return {ok:true,damage,hp:p.hp,event:this.events};
  }
  flushPending(){this.pending=this.pending.filter(h=>{const r=this.hit(h);if(r.reason!=='await_shot'){this.record('candidate_result',{messageId:h.m.message_id,...r});return false;}if(this.now()>h.expires){this.record('candidate_result',{messageId:h.m.message_id,ok:false,reason:'shot_timeout'});return false;}return true;});}
  tick(){const t=this.now();
    for(const p of this.s.players){if(p.connected&&t-p.lastSeen>3000){p.connected=false;p.armed=false;if(this.s.phase==='ACTIVE')this.pause('端末通信断');}
      if(p.reloadUntil&&this.s.phase==='ACTIVE'&&t>=p.reloadUntil){p.ammo=this.s.rules.magazine;p.reloadUntil=0;this.record('reload_complete',{deviceId:p.id});}}
    if(this.s.phase==='COUNTDOWN'){
      if(t>=this.s.startAt-500&&this.s.players.some(p=>!p.connected||t-p.lastSeen>2500||!deviceReady(p)||p.ack!==this.s.commandId))this.pause('開始ACK未完了');
      else if(t>=this.s.startAt){this.s.phase='ACTIVE';this.s.endAt=this.s.startAt+this.s.remainingMs;for(const p of this.s.players){p.armed=true;if(p.reloadRemaining){p.reloadUntil=t+p.reloadRemaining;p.reloadRemaining=0;}}this.record('start',{});}
    }
    if(this.s.phase==='ACTIVE'){this.s.remainingMs=Math.max(0,this.s.endAt-t);this.flushPending();if(!this.s.remainingMs)this.finish('time');}
    this.shots=this.shots.filter(s=>t-s.received<1200);for(const [k,v] of this.seen)if(t-v>10000)this.seen.delete(k);
  }
}
