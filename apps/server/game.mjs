import { randomUUID } from 'node:crypto';
import {hardware,receiverIds,deviceReady,legacyMotorDemo,receiverOnlyGame} from './hardware.mjs';
import {decodeGameFrame} from './ir-frame.mjs';
export const countdownDurationMs = 7010;
export const intermissionDurationMs = 15000;
export const defaults = Object.freeze({mode:'FFA_KILLS_V1', rounds:4, durationSec:90, fireMs:1000, respawnMs:7000});
export function rulesOf(input={}) {
  for(const [key,value] of Object.entries(defaults))
    if(input[key]!==undefined&&input[key]!==value)throw Error(`${key} は固定ルールです`);
  return {...defaults};
}
const stats=p=>({kills:p.kills??0,deaths:p.deaths??0,shots:p.shots??0,hits:p.hits??0,hitShots:p.hitShots??0});
const accuracy=(hitShots,shots)=>shots?Math.round(hitShots/shots*1000)/10:0;
export class Game {
  constructor(devices,{now=Date.now,log=()=>{},saved=null,allowTestMode=true,autoAdvanceRounds=false}={}) {
    this.allowTestMode=allowTestMode;
    this.autoAdvanceRounds=autoAdvanceRounds;
    this.now=now; this.log=log; this.pending=[]; this.shots=[]; this.seen=new Map(); this.soundEvents=[]; this.activity=[]; this.events=saved?.eventNo??0;this.defaultPlayerNames=devices.map(device=>device.name);
    this.s={id:randomUUID(),generation:1,phase:'LOBBY',pauseReason:null,rules:{...defaults},round:1,roundResults:[],remainingMs:defaults.durationSec*1000,intermissionEndsAt:null,intermissionBlockedReason:null,ticketRoundId:null,ticketStarted:false,ticketPaused:false,media:'score',winner:null,testMode:false,participantIds:[],
      players:devices.map(d=>({id:d.id,name:d.name,shooterId:d.shooterId,hp:1,kills:0,deaths:0,shots:0,hits:0,hitShots:0,accuracy:0,respawnAt:0,connected:false,armed:false,lastSeen:0,bootId:null,ack:null,lastShot:-1e15,rssi:null,battery:null,syncRtt:null}))};
    this.s.roundStart=Object.fromEntries(this.s.players.map(p=>[p.id,stats(p)]));
    if(saved?.players?.length===4&&saved.rules?.mode===defaults.mode) {
      const oldDuration = saved.rules.durationSec === 120;
      const loadedRules = rulesOf(oldDuration ? {...saved.rules, durationSec: defaults.durationSec} : saved.rules);
      const remainingMs = oldDuration
        ? Math.max(0, Math.min(loadedRules.durationSec * 1000, loadedRules.durationSec * 1000 - (120000 - (saved.remainingMs ?? 120000))))
        : saved.remainingMs;
      this.s={...this.s,...saved,remainingMs,phase:['ACTIVE','COUNTDOWN'].includes(saved.phase)?'PAUSED':saved.phase,pauseReason:['ACTIVE','COUNTDOWN'].includes(saved.phase)?'server_restart':saved.pauseReason??null,generation:saved.generation+1,rules:loadedRules};
      this.s.players=devices.map(d=>{const old=saved.players.find(p=>p.id===d.id)??{};return {...old,id:d.id,name:old.name??d.name,shooterId:d.shooterId,connected:false,armed:false,lastSeen:0,ack:null,bootId:null,lastShot:-1e15};});
      this.s.testMode= saved.testMode===true;
      this.s.participantIds=Array.isArray(saved.participantIds)?saved.participantIds:devices.map(d=>d.id);
      if(this.s.phase==='INTERMISSION'&&autoAdvanceRounds&&!this.s.testMode&&!Number.isFinite(this.s.intermissionEndsAt))this.s.intermissionEndsAt=this.now()+intermissionDurationMs;
      this.record('recovery',{phase:this.s.phase});
    } else if(saved?.players?.length===4) {
      for(const p of this.s.players)p.name=saved.players.find(old=>old.id===p.id)?.name??p.name;
    }
    for(const p of this.s.players)Object.assign(p,{hardwareProfile:null,hardwareReady:false,firmwareVersion:null,bench:false,lowBattery:false,motorActive:false,motorDuty:null,motorPwmLimit:null,motorRunLimit:null,motorStartupMs:null,motorHwDuty:null,shotCooldownMs:null,ignoredShots:null,ledReady:null,ledWhite20:null,motorPattern:null,motorQueueDepth:null,motorDroppedCommands:null,resetReason:null,demoShots:null,demoHits:null,demoDefeats:null,demoRevives:null,demoCountdownBeats:null,demoDefeatPulses:null,diagnosticCapable:false,diagnosticMode:false,triggerDown:null,triggerPresses:null,lastTriggerAt:null,motorPulses:null,lastMotorAt:null,ledColor:null,rxFrames:{},lastIr:null,lastReceiver:null,damageFeedback:null,reviveProgressMs:0});
    if(!allowTestMode&&this.s.testMode){this.s.phase='FINISHED';this.reset(this.s.rules);}
  }
  record(type,payload){const at=this.now();this.s.eventNo=++this.events;this.log({n:this.events,at,gameId:this.s.id,type,...payload});
    if(['shot','hit','respawn'].includes(type)){this.activity.push({n:this.events,at,type,...payload});if(this.activity.length>60)this.activity.shift();}
    const kind=['shot','motor_demo_shot'].includes(type)?'shot':type==='motor_demo_hit'?'hit':type==='motor_demo_defeat'?'defeat':type==='motor_demo_revive'?'revive':type==='hit'?'defeat':type==='respawn'?'revive':['round_end','finish'].includes(type)?'match-end':null;
    if(kind){this.soundEvents.push({n:this.events,at,kind});if(this.soundEvents.length>64)this.soundEvents.shift();}
  }
  player(id){const p=this.s.players.find(p=>p.id===id);if(!p)throw Error('未登録端末');return p;}
  participants(){return this.s.players.filter(p=>this.s.participantIds.includes(p.id));}
  isParticipant(id){return this.s.participantIds.includes(id);}
  testReady(p){return deviceReady(p,{allowLowBattery:true})||legacyMotorDemo(p);}
  gameDeviceReady(p){return deviceReady(p,{allowLowBattery:this.s.testMode});}
  batteryOverride(p){return this.s.testMode&&this.isParticipant(p.id)&&['COUNTDOWN','ACTIVE'].includes(this.s.phase);}
  readyForMatch(p){return this.s.testMode?this.testReady(p):deviceReady(p);}
  current(p){return p.connected&&this.now()-p.lastSeen<=2500&&p.syncRtt!==null&&p.syncRtt<=400;}
  view(){return structuredClone({...this.s,serverMs:this.now(),soundEvents:this.soundEvents,activity:this.activity});}
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
  reset(rules={}){if(!['LOBBY','FINISHED'].includes(this.s.phase)&&!(this.s.phase==='INTERMISSION'&&this.s.testMode))throw Error('終了してから新試合を作成してください');
    const r=rulesOf(rules);this.s.id=randomUUID();this.s.generation++;this.s.phase='LOBBY';this.s.pauseReason=null;this.s.rules=r;this.s.round=1;this.s.roundResults=[];this.s.remainingMs=r.durationSec*1000;this.s.intermissionEndsAt=null;this.s.intermissionBlockedReason=null;this.s.ticketRoundId=null;this.s.ticketStarted=false;this.s.ticketPaused=false;this.s.winner=null;this.s.testMode=false;this.s.participantIds=[];this.s.media='score';this.s.videoPlayback=null;
    for(const p of this.s.players)Object.assign(p,{hp:1,kills:0,deaths:0,shots:0,hits:0,hitShots:0,accuracy:0,armed:false,ack:null,lastShot:-1e15,deadAt:0,respawnAt:0,respawnRemainingMs:0,reviveProgressMs:0});
    this.s.roundStart=Object.fromEntries(this.s.players.map(p=>[p.id,stats(p)]));
    for(const p of this.s.players){p.damageFeedback=null;p.lastReceiver=null;}
    this.shots=[];this.pending=[];this.seen.clear();this.soundEvents=[];this.activity=[];this.record('new_game',{rules:r});}
  start(displayReady,{testMode=false,automatic=false}={}){if(!['LOBBY','PAUSED','INTERMISSION'].includes(this.s.phase))throw Error('待機・停止中・途中経過表示中のみ開始できます');
    if(this.s.phase==='INTERMISSION'&&this.autoAdvanceRounds&&!automatic)throw Error('次ゲームは途中経過の15秒後に自動開始します');
    if(!displayReady)throw Error('投影画面で「表示を準備」を押してください');
    const resuming=this.s.phase==='PAUSED';
    const nextRound=this.s.phase==='INTERMISSION';
    const mode=(resuming||nextRound)?this.s.testMode:testMode===true;
    if(mode&&!this.allowTestMode)throw Error('動作確認は「起動_デモ.cmd」で実行してください');
    const selected=(resuming||nextRound)?this.participants():mode?this.s.players.filter(p=>p.connected):this.s.players;
    if(!selected.length)throw Error('接続・時刻同期した端末が1台以上必要です');
    if(!mode&&selected.some(receiverOnlyGame))throw Error('受信専用端末は「接続済み端末だけで動作確認」で使用してください');
    if(!mode&&selected.length!==4)throw Error('通常試合は4台必要です');
    if(!mode&&selected.some(p=>!['0.8.0-4e42','0.8.1-4e42','0.8.0-sim'].includes(p.firmwareVersion)))throw Error('通常試合には4台とも個人戦用v0.8ファームウェアが必要です');
    if(selected.some(p=>!this.current(p)))throw Error('参加端末の接続・時刻同期を確認してください');
    if(selected.some(p=>mode?!this.testReady(p):!deviceReady(p)))throw Error(mode?'参加端末の構成・通常モードを確認してください':'4台の個人戦対応・通常モード・電池状態を確認してください');
    this.s.testMode=mode;this.s.participantIds=selected.map(p=>p.id);
    this.s.generation++;this.s.phase='COUNTDOWN';this.s.pauseReason=null;this.s.intermissionEndsAt=null;this.s.intermissionBlockedReason=null;this.s.startAt=this.now()+countdownDurationMs;this.s.countdownAudioStartAt=this.s.startAt-countdownDurationMs;this.s.commandId=randomUUID();this.s.startCommitted=selected.every(p=>!this.gameDeviceReady(p));this.s.media='score';this.s.videoPlayback=null;
    if(nextRound){for(const p of this.s.players)Object.assign(p,{hp:1,deadAt:0,respawnAt:0,respawnRemainingMs:0,lastShot:-1e15,reviveProgressMs:0});this.s.roundStart=Object.fromEntries(this.s.players.map(p=>[p.id,stats(p)]));this.s.remainingMs=this.s.rules.durationSec*1000;}
    if(resuming)for(const p of this.s.players)if(p.hp===0&&p.respawnRemainingMs>0){p.respawnAt=this.s.startAt+p.respawnRemainingMs;p.respawnRemainingMs=0;}
    for(const p of this.s.players){p.ack=null;p.armed=false;p.damageFeedback=null;}this.record('countdown',{startAt:this.s.startAt,commandId:this.s.commandId,testMode:mode,participantIds:this.s.participantIds});}
  pause(reason='operator'){if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());
    if(['ACTIVE','COUNTDOWN'].includes(this.s.phase)){this.s.phase='PAUSED';this.s.pauseReason=reason;this.s.generation++;this.s.startCommitted=false;for(const p of this.s.players){p.armed=false;if(p.hp===0)p.respawnRemainingMs=Math.max(0,p.respawnAt-this.now());}this.pending=[];this.shots=[];this.record('pause',{reason});}}
  endRound(reason='time'){
    if(!['ACTIVE','PAUSED'].includes(this.s.phase))throw Error('進行中のゲームだけ終了できます');
    if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());
    const completedRound=this.s.round;
    const players=this.s.players.map(p=>{const before=this.s.roundStart[p.id]??stats({});const now=stats(p);return {id:p.id,name:p.name,kills:now.kills-before.kills,deaths:now.deaths-before.deaths,shots:now.shots-before.shots,hits:now.hits-before.hits,accuracy:accuracy(now.hitShots-before.hitShots,now.shots-before.shots),totalKills:p.kills};});
    this.s.roundResults.push({round:completedRound,players});
    if(completedRound<this.s.rules.rounds){this.s.generation++;for(const p of this.s.players)p.armed=false;this.pending=[];this.shots=[];this.s.round++;this.s.phase='INTERMISSION';this.s.remainingMs=this.s.rules.durationSec*1000;this.s.intermissionEndsAt=this.autoAdvanceRounds&&!this.s.testMode?this.now()+intermissionDurationMs:null;this.record('round_end',{reason,round:completedRound,players});return;}
    this.finishMatch(reason,{completedRound,players});
  }
  finishMatch(reason='operator',{completedRound=null,players=null}={}){
    if(this.s.phase==='FINISHED')return;
    if(!['COUNTDOWN','ACTIVE','PAUSED','INTERMISSION'].includes(this.s.phase))throw Error('開始後のみ終了できます');
    if(this.s.phase==='ACTIVE')this.s.remainingMs=Math.max(0,this.s.endAt-this.now());
    if(this.s.phase==='INTERMISSION')this.s.round=this.s.roundResults.at(-1)?.round??this.s.round;
    if(this.s.phase!=='INTERMISSION'&&completedRound===null){
      completedRound=this.s.round;
      players=this.s.players.map(p=>{const before=this.s.roundStart[p.id]??stats({});const now=stats(p);return {id:p.id,name:p.name,kills:now.kills-before.kills,deaths:now.deaths-before.deaths,shots:now.shots-before.shots,hits:now.hits-before.hits,accuracy:accuracy(now.hitShots-before.hitShots,now.shots-before.shots),totalKills:p.kills};});
      this.s.roundResults.push({round:completedRound,players});
    }
    this.s.generation++;for(const p of this.s.players)p.armed=false;
    this.pending=[];this.shots=[];this.s.remainingMs=0;this.s.intermissionEndsAt=null;this.s.intermissionBlockedReason=null;
    this.s.phase='FINISHED';const leaders=[...this.s.players].sort((a,b)=>b.kills-a.kills);this.s.winner=this.s.testMode?null:leaders[0].kills===leaders[1].kills?'DRAW':leaders[0].id;
    this.record('finish',{reason,winner:this.s.winner,round:completedRound??this.s.roundResults.at(-1)?.round??0,players});
  }
  finish(reason='operator'){this.finishMatch(reason);}
  hello(id,bootId){const p=this.player(id);if(typeof bootId!=='string'||bootId.length>80)throw Error('boot_id不正');
    if(p.bootId!==bootId){p.armed=false;p.syncRtt=null;p.hardwareReady=false;p.hardwareProfile=null;p.lastIr=null;p.damageFeedback=null;p.triggerPresses=null;p.motorPulses=null;p.lastTriggerAt=null;p.lastMotorAt=null;if(this.isParticipant(id)&&['ACTIVE','COUNTDOWN'].includes(this.s.phase))this.pause('端末再起動');}p.bootId=bootId;p.connected=true;p.lastSeen=this.now();}
  heartbeat(id,data){const p=this.player(id);p.connected=true;p.lastSeen=this.now();p.battery=Number.isFinite(data.battery)&&data.battery>=0?data.battery:null;p.rssi=data.rssi??null;
    p.batteryReplaceVoltage=Number.isFinite(data.battery_replace_v)&&data.battery_replace_v>0&&data.battery_replace_v<=30?data.battery_replace_v:null;
    p.syncRtt=Number.isFinite(data.syncRtt)&&data.syncRtt>=0?data.syncRtt:null;
    p.hardwareProfile=typeof data.hardware_profile==='string'?data.hardware_profile.slice(0,80):null;
    p.hardwareReady=data.hardware_ready===true;p.firmwareVersion=typeof data.firmware_version==='string'?data.firmware_version.slice(0,24):null;
    p.bench=data.bench===true;p.lowBattery=data.lowBattery===true;p.motorActive=data.motor_active===true;
    p.diagnosticCapable=data.diagnostic_capable===true;p.diagnosticMode=data.diagnostic_mode===true;
    p.triggerDown=typeof data.trigger_down==='boolean'?data.trigger_down:null;
    const triggerPresses=Number.isSafeInteger(data.trigger_presses)&&data.trigger_presses>=0?data.trigger_presses:null;
    if(p.triggerPresses!==null&&triggerPresses!==null&&triggerPresses>p.triggerPresses)p.lastTriggerAt=this.now();
    p.triggerPresses=triggerPresses;
    const motorPulses=Number.isSafeInteger(data.motor_pulses)&&data.motor_pulses>=0?data.motor_pulses:null;
    if(p.motorPulses!==null&&motorPulses!==null&&motorPulses>p.motorPulses)p.lastMotorAt=this.now();
    p.motorPulses=motorPulses;
    p.ledColor=typeof data.led_color==='string'&&/^(OFF|RED|BLUE|GREEN|CYAN|ORANGE|PURPLE|WHITE|MIXED)$/.test(data.led_color)?data.led_color:null;
    p.motorPwmLimit=Number.isInteger(data.motor_pwm_limit)&&data.motor_pwm_limit>0&&data.motor_pwm_limit<=255?data.motor_pwm_limit:null;
    p.motorRunLimit=Number.isInteger(data.motor_run_limit)&&data.motor_run_limit>0&&data.motor_run_limit<=255?data.motor_run_limit:null;
    p.motorStartupMs=Number.isInteger(data.motor_startup_ms)&&data.motor_startup_ms>0&&data.motor_startup_ms<=100?data.motor_startup_ms:null;
    p.motorHwDuty=Number.isInteger(data.motor_hw_duty)&&data.motor_hw_duty>=0&&data.motor_hw_duty<=256?data.motor_hw_duty:null;
    p.motorDuty=Number.isInteger(data.motor_duty)&&data.motor_duty>=0&&data.motor_duty<=255?data.motor_duty:null;
    p.shotCooldownMs=Number.isInteger(data.shot_cooldown_ms)&&data.shot_cooldown_ms>=0&&data.shot_cooldown_ms<=10000?data.shot_cooldown_ms:null;
    p.ignoredShots=Number.isInteger(data.ignored_shots)&&data.ignored_shots>=0?data.ignored_shots:null;
    p.ledReady=typeof data.led_ready==='boolean'?data.led_ready:null;
    p.ledWhite20=typeof data.led_white20==='boolean'?data.led_white20:null;
    p.motorPattern=['OFF','SHOT','HIT','COUNTDOWN','DEFEAT','REVIVE'].includes(data.motor_pattern)?data.motor_pattern:null;
    p.motorQueueDepth=Number.isInteger(data.motor_queue_depth)&&data.motor_queue_depth>=0&&data.motor_queue_depth<=8?data.motor_queue_depth:null;
    p.motorDroppedCommands=Number.isSafeInteger(data.motor_dropped_commands)&&data.motor_dropped_commands>=0?data.motor_dropped_commands:null;
    p.resetReason=Number.isInteger(data.reset_reason)&&data.reset_reason>=0&&data.reset_reason<=32?data.reset_reason:null;
    p.demoShots=Number.isSafeInteger(data.demo_shots)&&data.demo_shots>=0?data.demo_shots:null;
    p.demoHits=Number.isSafeInteger(data.demo_hits)&&data.demo_hits>=0?data.demo_hits:null;
    p.demoDefeats=Number.isSafeInteger(data.demo_defeats)&&data.demo_defeats>=0?data.demo_defeats:null;
    p.demoRevives=Number.isSafeInteger(data.demo_revives)&&data.demo_revives>=0?data.demo_revives:null;
    p.demoCountdownBeats=Number.isSafeInteger(data.demo_countdown_beats)&&data.demo_countdown_beats>=0?data.demo_countdown_beats:null;
    p.demoCountdownMissed=Number.isSafeInteger(data.demo_countdown_missed)&&data.demo_countdown_missed>=0?data.demo_countdown_missed:null;
    p.demoDefeatPulses=Number.isSafeInteger(data.demo_defeat_pulses)&&data.demo_defeat_pulses>=0?data.demo_defeat_pulses:null;
    p.rxFrames=Object.fromEntries(receiverIds.map(k=>[k,Number.isSafeInteger(data.rx_frames?.[k])&&data.rx_frames[k]>=0?data.rx_frames[k]:null]));
    const decoded=decodeGameFrame(data.last_ir?.frame),source=decoded?this.s.players.find(x=>x.shooterId===decoded.shooterId):null;
    p.lastIr=decoded&&receiverIds.includes(data.last_ir?.receiver_id)?{...decoded,frame:data.last_ir.frame,receiverId:data.last_ir.receiver_id,sourceName:source?.name??null,relation:!source?'UNKNOWN':source.id===id?'SELF':'OPPONENT'}:null;
    if(this.isParticipant(id)&&!this.readyForMatch(p)&&['ACTIVE','COUNTDOWN'].includes(this.s.phase))this.pause(p.lowBattery?'電池低下':'端末構成・机上モードを確認');}
  ack(id,payload){const p=this.player(id);if(this.s.phase==='COUNTDOWN'&&this.isParticipant(id)&&this.gameDeviceReady(p)&&payload.command_id===this.s.commandId&&payload.result==='ok'){p.ack=this.s.commandId;this.s.startCommitted=this.participants().every(p=>!this.gameDeviceReady(p)||p.ack===this.s.commandId);}}
  event(id,m){this.tick();const p=this.player(id),t=this.now();
    if(!m||m.device_id!==id||m.boot_id!==p.bootId||typeof m.message_id!=='string'||m.message_id.length>160||!Number.isSafeInteger(m.seq))return {ok:false,reason:'envelope'};
    if(m.game_id!==this.s.id||m.game_generation!==this.s.generation)return {ok:false,reason:'old_game'};
    if(this.seen.has(`${id}/${m.message_id}`))return {ok:false,reason:'duplicate'};this.seen.set(`${id}/${m.message_id}`,t);
    const e=m.payload??{};
    if(m.type==='command_ack'){this.ack(id,e);return {ok:true};}
    if(this.s.phase!=='ACTIVE'||!p.armed||!p.connected||!this.gameDeviceReady(p))return {ok:false,reason:'not_active'};
    // Bound device time to reception time. Device clock cannot extend the game deadline.
    const at=Number.isFinite(m.server_time_ms)?m.server_time_ms:t;
    if(Math.abs(t-at)>500||at<this.s.startAt||t>=this.s.endAt)return {ok:false,reason:'time_window'};
    if(receiverOnlyGame(p)&&['shot_fired','shot_hold','shot_released'].includes(m.type))return {ok:false,reason:'receiver_only'};
    if(m.type==='shot_fired'){
      // Allow a shot already in flight just before an opposing lethal hit (bounded 150 ms).
      if(p.hp<=0&&!(p.deadAt&&at<p.deadAt&&t-p.deadAt<=150))return {ok:false,reason:'dead'};
      if(at-p.lastShot<this.s.rules.fireMs-15)return {ok:false,reason:'rate'};
      if(!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255||e.weapon_id!==1)return {ok:false,reason:'weapon'};
      p.lastShot=at;p.shots++;p.accuracy=accuracy(p.hitShots,p.shots);this.shots.push({shooter:id,seq:e.shot_seq,at,received:t,victims:new Set(),hitCredited:false});
      this.record('shot',{deviceId:id,seq:e.shot_seq});this.flushPending();return {ok:true};
    }
    if(m.type==='shot_hold'||m.type==='shot_released')return {ok:false,reason:'unsupported'};
    if(m.type==='hit_candidate'){
      if(p.hp<=0)return {ok:false,reason:'dead'};
      const hit={id,m,at,received:t,expires:t+350};const result=this.hit(hit);
      if(result.reason==='await_shot'){if(this.pending.length>=256)return {ok:false,reason:'overflow'};this.pending.push(hit);return {ok:false,reason:'pending'};}return result;
    }return {ok:false,reason:'unknown_type'};
  }
  hit(h){const p=this.player(h.id),e=h.m.payload;const shooter=this.s.players.find(x=>x.shooterId===e.shooter_id);
    if(!shooter||shooter.id===p.id||e.weapon_id!==1||!receiverIds.includes(e.receiver_id)||!Number.isInteger(e.shot_seq)||e.shot_seq<0||e.shot_seq>255||(e.flags??0)!==0)return {ok:false,reason:'invalid_ir'};
    const shot=this.shots.findLast(x=>x.shooter===shooter.id&&x.seq===e.shot_seq&&h.at-x.at>=-150&&h.at-x.at<=500);
    if(!shot)return {ok:false,reason:'await_shot'};
    if(shot.victims.has(p.id))return {ok:false,reason:'duplicate_hit'};
    if(p.hp<=0)return {ok:false,reason:'dead'};
    shot.victims.add(p.id);const before=p.hp;p.hp=0;p.deadAt=h.at;p.respawnAt=h.at+this.s.rules.respawnMs;p.deaths++;
    shooter.kills++;shooter.hits++;if(!shot.hitCredited){shot.hitCredited=true;shooter.hitShots++;}shooter.accuracy=accuracy(shooter.hitShots,shooter.shots);
    p.lastReceiver=e.receiver_id;this.record('hit',{deviceId:p.id,shooter:shooter.id,receiverId:e.receiver_id,candidate_message_id:h.m.message_id,before,hp:0,kill:true,respawnAt:p.respawnAt});
    p.damageFeedback={id:this.events,at:this.now(),duration_ms:hardware.outputs.motor.hitPulseMs};
    return {ok:true,kill:true,hp:0,event:this.events};
  }
  flushPending(){this.pending=this.pending.filter(h=>{const r=this.hit(h);if(r.reason!=='await_shot'){this.record('candidate_result',{messageId:h.m.message_id,...r});return false;}if(this.now()>h.expires){this.record('candidate_result',{messageId:h.m.message_id,ok:false,reason:'shot_timeout'});return false;}return true;});}
  tick(displayReady=false){const t=this.now();
    for(const p of this.s.players)if(p.connected&&t-p.lastSeen>3000){p.connected=false;p.armed=false;if(this.isParticipant(p.id)&&this.s.phase==='ACTIVE')this.pause('端末通信断');}
    if(this.s.phase==='COUNTDOWN'){
      if(t>=this.s.startAt-500&&this.participants().some(p=>!this.current(p)||!this.readyForMatch(p)||(this.gameDeviceReady(p)&&p.ack!==this.s.commandId)))this.pause('参加端末の開始準備未完了');
      else if(t>=this.s.startAt){this.s.phase='ACTIVE';this.s.endAt=this.s.startAt+this.s.remainingMs;for(const p of this.s.players)p.armed=this.isParticipant(p.id)&&this.gameDeviceReady(p);this.record('start',{testMode:this.s.testMode,participantIds:this.s.participantIds});}
    }
    if(this.s.phase==='ACTIVE'){
      this.s.remainingMs=Math.max(0,this.s.endAt-t);this.flushPending();
      for(const p of this.s.players)if(p.hp===0&&p.respawnAt&&t>=p.respawnAt){p.hp=1;p.deadAt=0;p.respawnAt=0;this.record('respawn',{deviceId:p.id});}
      if(!this.s.remainingMs)this.endRound('time');
    }
    if(this.s.phase==='INTERMISSION'&&this.autoAdvanceRounds&&!this.s.testMode&&Number.isFinite(this.s.intermissionEndsAt)&&t>=this.s.intermissionEndsAt){
      try{this.start(displayReady,{automatic:true});}
      catch(error){this.s.intermissionBlockedReason=error.message;}
    }
    this.shots=this.shots.filter(s=>t-s.received<1200);
    for(const [k,v] of this.seen)if(t-v>10000)this.seen.delete(k);
  }
}
