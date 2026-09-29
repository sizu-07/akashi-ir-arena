import { randomUUID } from 'node:crypto';
import {hardware,receiverIds,deviceReady} from './hardware.mjs';
export const countdownDurationMs = 7010;
export const defaults = Object.freeze({hp:100, damage:5, durationSec:300, fireMs:1000, invulnerableMs:300, reviveMs:3000, reviveHp:50, friendlyFire:false});
export function rulesOf(input={}) {
  const r={...defaults,...input};
  const bounds={hp:[1,1000],damage:[1,1000],durationSec:[10,3600],fireMs:[1000,1000],invulnerableMs:[0,3000],reviveMs:[3000,3000],reviveHp:[1,1000]};
  for(const [k,[a,b]] of Object.entries(bounds)) if(!Number.isInteger(r[k])||r[k]<a||r[k]>b) throw Error(`${k}: ${a}〜${b}の整数が必要です`);
  if(r.reviveHp>r.hp)throw Error('復活HPは最大HP以下にしてください');
  if(typeof r.friendlyFire!=='boolean') throw Error('friendlyFireは真偽値');
  return Object.fromEntries([...Object.keys(bounds),'friendlyFire'].map(k=>[k,r[k]]));
}
export class Game {
  constructor(devices,{now=Date.now,log=()=>{},saved=null}={}) {
    this.now=now; this.log=log; this.pending=[]; this.shots=[]; this.revives=new Map(); this.seen=new Map(); this.soundEvents=[]; this.events=saved?.eventNo??0;this.defaultPlayerNames=devices.map(device=>device.name);
    this.s={id:randomUUID(),generation:1,phase:'LOBBY',rules:{...defaults},remainingMs:300000,score:{A:0,B:0},media:'score',winner:null,
      players:devices.map(d=>({id:d.id,name:d.name,team:d.team,shooterId:d.shooterId,hp:100,connected:false,armed:false,lastSeen:0,bootId:null,ack:null,lastShot:-1e15,invUntil:0,rssi:null,battery:null,syncRtt:null}))};
    if(saved?.players?.length===4) {
      this.s={...saved,phase:['ACTIVE','COUNTDOWN','PAUSED'].includes(saved.phase)?'PAUSED':saved.phase,generation:saved.generation+1};
      const legacy=!Number.isInteger(saved.rules?.reviveMs);
      this.s.rules=rulesOf(legacy?{...saved.rules,damage:5,fireMs:1000,reviveMs:3000,reviveHp:Math.min(50,saved.rules?.hp??100)}:saved.rules);
      this.s.players=devices.map(d=>{const {ammo,reloadUntil,reloadRemaining,...old}=saved.players.find(p=>p.id===d.id)??{};return {...old,...d,key:undefined,connected:false,armed:false,lastSeen:0,ack:null,bootId:null,lastShot:-1e15};});
      this.record('recovery',{phase:this.s.phase});
    }
    for(const p of this.s.players)Object.assign(p,{hardwareProfile:null,hardwareReady:false,firmwareVersion:null,bench:false,lowBattery:false,motorActive:false,demoShots:null,demoHits:null,rxFrames:{},lastReceiver:null,damageFeedback:null,reviveProgressMs:0});
  }
  record(type,payload){const at=this.now();this.s.eventNo=++this.events;this.log({n:this.events,at,gameId:this.s.id,type,...payload});
    const kind=type==='shot'?'shot':type==='hit'?(payload.hp===0?'defeat':'hit'):type==='revive'?'revive':type==='finish'?'match-end':null;
    if(kind){this.soundEvents.push({n:this.events,at,kind});if(this.soundEvents.length>64)this.soundEvents.shift();}
  }
  player(id){const p=this.s.players.find(p=>p.id===id);if(!p)throw Error('未登録端末');return p;}
  view(){return structuredClone({...this.s,serverMs:this.now(),soundEvents:this.soundEvents});}
  setMedia(mode) {
    if (!['score', 'rules', 'video', 'black'].includes(mode)) throw Error('映像モード不正');
    if (['ACTIVE', 'COUNTDOWN'].includes(this.s.phase)) throw Error('試合中は映像切替できません');
    if (mode === 'video') return this.controlVideo('restart');
    if (this.s.media === 'video') this.controlVideo('pause');
    this.s.media = mode;
  }
  controlVideo(action) {
    if (!['play', 'pause', 'restart'].includes(action)) throw Error('動画操作不正');
    if (['ACTIVE', 'COUNTDOWN'].includes(this.s.phase)) throw Error('試合中は動画を操作できません');
    if (action === 'pause' && this.s.media !== 'video') throw Error('動画を表示してから停止してください');
    const now = this.now();
    const previous = this.s.videoPlayback;
    const positionMs = action === 'restart' ? 0 : (previous?.positionMs ?? 0) +
      (previous?.playing ? Math.max(0, now - previous.updatedAt) : 0);
    this.s.media = 'video';
    this.s.videoPlayback = {positionMs, updatedAt: now, playing: action !== 'pause', commandId: randomUUID()};
    this.record('video_control', {action, positionMs});
  }
  setPlayerNames(names=[]){for(const [index,player] of this.s.players.entries()){const name=String(names[index]??'').trim();player.name=name&&name.length<=20?name:this.defaultPlayerNames[index];}this.record('player_names_updated',{names:this.s.players.map(player=>player.name)});}
  reset(rules){if(!['LOBBY','FINISHED'].includes(this.s.phase))throw Error('終了してから新試合を作成してください');
    const r=rulesOf(rules);this.s.id=randomUUID();this.s.generation++;this.s.phase='LOBBY';this.s.rules=r;this.s.remainingMs=r.durationSec*1000;this.s.score={A:0,B:0};this.s.winner=null;this.s.media='score';this.s.videoPlayback=null;
    for(const p of this.s.players)Object.assign(p,{hp:r.hp,armed:false,ack:null,lastShot:-1e15,deadAt:0,invUntil:0,reviveProgressMs:0});
    for(const p of this.s.players){p.damageFeedback=null;p.lastReceiver=null;}
    this.shots=[];this.pending=[];this.revives.clear();this.seen.clear();this.soundEvents=[];this.record('new_game',{rules:r});}
  start(displayReady){if(!['LOBBY','PAUSED'].includes(this.s.phase))throw Error('待機・停止中のみ開始できます');
    if(!displayReady)throw Error('投影画面で「表示を準備」を押してください');
    if(this.s.players.some(p=>!p.connected||this.now()-p.lastSeen>2500||p.syncRtt===null||p.syncRtt>400))throw Error('4台の接続・時刻同期を確認してください');
    if(this.s.players.some(p=>!deviceReady(p)))throw Error('4台のv0.7対応・通常モード・電池状態を確認してください');
    this.s.generation++;this.s.phase='COUNTDOWN';this.s.startAt=this.now()+countdownDurationMs;this.s.countdownAudioStartAt=this.s.startAt-countdownDurationMs;this.s.commandId=randomUUID();this.s.startCommitted=false;this.s.media='score';this.s.videoPlayback=null;
    for(const p of this.s.players){p.ack=null;p.armed=false;p.damageFeedback=null;}this.record('countdown',{startAt:this.s.startAt,commandId:this.s.commandId});}
  pause(reason='operator'){if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());
    if(['ACTIVE','COUNTDOWN'].includes(this.s.phase)){this.s.phase='PAUSED';this.s.generation++;this.s.startCommitted=false;for(const p of this.s.players){p.armed=false;p.reviveProgressMs=0;}this.pending=[];this.shots=[];this.revives.clear();this.record('pause',{reason});}}
  finish(reason='operator'){if(this.s.phase==='FINISHED')return;if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());this.s.phase='FINISHED';this.s.generation++;for(const p of this.s.players)p.armed=false;
    const hp=t=>this.s.players.filter(p=>p.team===t).reduce((a,p)=>a+p.hp,0);const a=this.s.score.A,b=this.s.score.B;this.s.winner=a!==b?(a>b?'A':'B'):(hp('A')===hp('B')?'DRAW':hp('A')>hp('B')?'A':'B');this.pending=[];this.shots=[];this.revives.clear();for(const p of this.s.players)p.reviveProgressMs=0;this.record('finish',{reason,winner:this.s.winner});}
  correct(id,hp,reason){if(!reason?.trim()||!Number.isInteger(hp)||hp<0||hp>this.s.rules.hp)throw Error('補正理由と範囲内のHPが必要です');
    if(this.s.phase!=='PAUSED'&&this.s.phase!=='LOBBY')throw Error('HP補正は待機・一時停止中のみ可能です');const p=this.player(id);const before=p.hp;p.hp=hp;p.reviveProgressMs=0;this.revives.delete(id);this.record('hp_correction',{deviceId:id,before,after:hp,reason});}
  hello(id,bootId){const p=this.player(id);if(typeof bootId!=='string'||bootId.length>80)throw Error('boot_id不正');
    if(p.bootId!==bootId){p.armed=false;p.syncRtt=null;p.hardwareReady=false;p.hardwareProfile=null;p.damageFeedback=null;if(['ACTIVE','COUNTDOWN'].includes(this.s.phase))this.pause('端末再起動');}p.bootId=bootId;p.connected=true;p.lastSeen=this.now();}
  heartbeat(id,data){const p=this.player(id);p.connected=true;p.lastSeen=this.now();p.battery=Number.isFinite(data.battery)?data.battery:null;p.rssi=data.rssi??null;
    p.syncRtt=Number.isFinite(data.syncRtt)&&data.syncRtt>=0?data.syncRtt:null;
    p.hardwareProfile=typeof data.hardware_profile==='string'?data.hardware_profile.slice(0,80):null;
    p.hardwareReady=data.hardware_ready===true;p.firmwareVersion=typeof data.firmware_version==='string'?data.firmware_version.slice(0,24):null;
    p.bench=data.bench===true;p.lowBattery=data.lowBattery===true;p.motorActive=data.motor_active===true;
    p.demoShots=Number.isSafeInteger(data.demo_shots)&&data.demo_shots>=0?data.demo_shots:null;
    p.demoHits=Number.isSafeInteger(data.demo_hits)&&data.demo_hits>=0?data.demo_hits:null;
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
      if(at-p.lastShot<this.s.rules.fireMs-15)return {ok:false,reason:'rate'};
      if(!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255||e.weapon_id!==1)return {ok:false,reason:'weapon'};
      p.lastShot=at;this.shots.push({shooter:id,seq:e.shot_seq,at,received:t,holdUntil:t+700,victims:new Set()});
      this.record('shot',{deviceId:id,seq:e.shot_seq});this.flushPending();return {ok:true};
    }
    if(m.type==='shot_hold'||m.type==='shot_released'){
      const shot=this.shots.findLast(x=>x.shooter===id&&x.seq===e.shot_seq);
      if(!shot||!Number.isInteger(e.shot_seq))return {ok:false,reason:'unknown_shot'};
      if(m.type==='shot_hold'){
        if(shot.released||p.hp<=0)return {ok:false,reason:'hold_ended'};
        shot.holdUntil=t+700;
      }else{
        shot.released=true;shot.holdUntil=t;
        for(const [victimId,progress] of this.revives)if(progress.shooter===id&&progress.seq===e.shot_seq){this.revives.delete(victimId);this.player(victimId).reviveProgressMs=0;}
      }
      return {ok:true};
    }
    if(m.type==='hit_candidate'){
      if(p.hp<=0&&e.flags!==1)return {ok:false,reason:'dead'};
      const hit={id,m,at,received:t,expires:t+350};const result=this.hit(hit);
      if(result.reason==='await_shot'){if(this.pending.length>=256)return {ok:false,reason:'overflow'};this.pending.push(hit);return {ok:false,reason:'pending'};}return result;
    }return {ok:false,reason:'unknown_type'};
  }
  hit(h){const p=this.player(h.id),e=h.m.payload;const shooter=this.s.players.find(x=>x.shooterId===e.shooter_id);
    if(!shooter||shooter.id===p.id||e.weapon_id!==1||!receiverIds.includes(e.receiver_id)||!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255||![0,1].includes(e.flags??0))return {ok:false,reason:'invalid_ir'};
    if(e.flags===1)return this.reviveHit(h,shooter);
    if(!this.s.rules.friendlyFire&&shooter.team===p.team)return {ok:false,reason:'friendly'};
    const shot=this.shots.findLast(x=>x.shooter===shooter.id&&x.seq===e.shot_seq&&h.at-x.at>=-150&&h.at-x.at<=500);
    if(!shot)return {ok:false,reason:'await_shot'};
    if(shot.victims.has(p.id))return {ok:false,reason:'duplicate_hit'};
    if(p.hp<=0||h.at<p.invUntil)return {ok:false,reason:'invulnerable_or_dead'};
    shot.victims.add(p.id);const before=p.hp;const damage=Math.min(p.hp,this.s.rules.damage);p.hp-=damage;p.invUntil=h.at+this.s.rules.invulnerableMs;
    if(!p.hp){p.deadAt=h.at;if(shooter.team!==p.team)this.s.score[shooter.team]++;}p.lastReceiver=e.receiver_id;this.record('hit',{deviceId:p.id,shooter:shooter.id,receiverId:e.receiver_id,candidate_message_id:h.m.message_id,before,hp:p.hp,damage});
    p.damageFeedback={id:this.events,at:this.now(),duration_ms:hardware.outputs.motor.hitPulseMs};
    return {ok:true,damage,hp:p.hp,event:this.events};
  }
  reviveHit(h,shooter){const p=this.player(h.id),e=h.m.payload;
    if(shooter.team!==p.team||shooter.hp<=0||!shooter.connected||!shooter.armed||p.hp>0)return {ok:false,reason:'revive_invalid'};
    const shot=this.shots.findLast(x=>x.shooter===shooter.id&&x.seq===e.shot_seq&&!x.released&&h.at-x.at>=-150&&h.at<=x.holdUntil);
    if(!shot)return {ok:false,reason:'await_shot'};
    const previous=this.revives.get(p.id);
    const progress=previous&&previous.shooter===shooter.id&&previous.seq===shot.seq&&h.at-previous.lastAt<=700
      ?previous:{shooter:shooter.id,seq:shot.seq,firstAt:h.at,lastAt:h.at};
    if(h.at<=progress.lastAt&&previous===progress)return {ok:false,reason:'duplicate_revival_sample'};
    progress.lastAt=h.at;this.revives.set(p.id,progress);
    if(h.at-progress.firstAt<this.s.rules.reviveMs){p.reviveProgressMs=Math.max(0,h.at-progress.firstAt);return {ok:true,progressMs:p.reviveProgressMs};}
    p.hp=this.s.rules.reviveHp;p.deadAt=0;p.invUntil=h.at+1000;p.reviveProgressMs=0;this.revives.delete(p.id);
    this.record('revive',{deviceId:p.id,shooter:shooter.id,hp:p.hp});return {ok:true,revived:true,hp:p.hp};
  }
  flushPending(){this.pending=this.pending.filter(h=>{const r=this.hit(h);if(r.reason!=='await_shot'){this.record('candidate_result',{messageId:h.m.message_id,...r});return false;}if(this.now()>h.expires){this.record('candidate_result',{messageId:h.m.message_id,ok:false,reason:'shot_timeout'});return false;}return true;});}
  tick(){const t=this.now();
    for(const p of this.s.players)if(p.connected&&t-p.lastSeen>3000){p.connected=false;p.armed=false;if(this.s.phase==='ACTIVE')this.pause('端末通信断');}
    if(this.s.phase==='COUNTDOWN'){
      if(t>=this.s.startAt-500&&this.s.players.some(p=>!p.connected||t-p.lastSeen>2500||!deviceReady(p)||p.ack!==this.s.commandId))this.pause('開始ACK未完了');
      else if(t>=this.s.startAt){this.s.phase='ACTIVE';this.s.endAt=this.s.startAt+this.s.remainingMs;for(const p of this.s.players)p.armed=true;this.record('start',{});}
    }
    if(this.s.phase==='ACTIVE'){this.s.remainingMs=Math.max(0,this.s.endAt-t);this.flushPending();if(!this.s.remainingMs)this.finish('time');}
    this.shots=this.shots.filter(s=>t-s.received<1200||s.holdUntil>t);
    for(const [id,r] of this.revives)if(t-r.lastAt>700||this.player(id).hp>0||this.player(r.shooter).hp<=0){this.revives.delete(id);this.player(id).reviveProgressMs=0;}
    for(const [k,v] of this.seen)if(t-v>10000)this.seen.delete(k);
  }
}
