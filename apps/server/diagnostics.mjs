import {decodeGameFrame} from './ir-frame.mjs';
import {receiverIds} from './hardware.mjs';

export class Diagnostics {
  constructor({now=Date.now, log=()=>{}}={}) {
    this.now=now;
    this.log=log;
    this.enabled=false;
    this.startedAt=null;
    this.intermissionRemainingMs=null;
    this.events=[];
    this.seen=new Set();
    this.players=new Map();
    this.shots=[];
    this.pending=[];
  }
  begin(game,{allowNoDevices=false}={}) {
    if(this.enabled)throw Error('一時診断はすでに実行中です');
    if(!allowNoDevices&&!game.s.players.some(p=>p.connected&&p.diagnosticCapable))throw Error('診断対応ファームウェアの接続端末がありません。端末を更新・接続してください');
    if(game.s.phase==='ACTIVE'||game.s.phase==='COUNTDOWN')game.pause('一時診断中');
    if(game.s.phase==='INTERMISSION'&&Number.isFinite(game.s.intermissionEndsAt)){
      this.intermissionRemainingMs=Math.max(0,game.s.intermissionEndsAt-this.now());
      game.s.intermissionEndsAt=null;
    }
    this.enabled=true;
    this.startedAt=this.now();
    this.events=[];
    this.seen.clear();
    this.shots=[];
    this.pending=[];
    this.players=new Map(game.s.players.map(player=>[player.id,{id:player.id,name:player.name,hp:1,kills:0,deaths:0,shots:0,respawnAt:0,lastShot:-Infinity}]));
    this.log({at:this.startedAt,type:'diagnostic_start',gameId:game.s.id,phase:game.s.phase});
  }
  end(game) {
    if(!this.enabled)throw Error('一時診断は実行されていません');
    this.enabled=false;
    this.shots=[];
    this.pending=[];
    if(game.s.phase==='INTERMISSION'&&this.intermissionRemainingMs!==null)game.s.intermissionEndsAt=this.now()+this.intermissionRemainingMs;
    this.intermissionRemainingMs=null;
    this.log({at:this.now(),type:'diagnostic_end',gameId:game.s.id,phase:game.s.phase});
  }
  receive(game,id,message) {
    if(!this.enabled)return {ok:false,reason:'diagnostic_off'};
    const player=game.player(id);
    if(!player.connected||!player.diagnosticCapable||message?.device_id!==id||message.boot_id!==player.bootId||message.game_id!==game.s.id||message.game_generation!==game.s.generation||typeof message.message_id!=='string'||message.message_id.length>160||!Number.isSafeInteger(message.seq)||!Number.isFinite(message.server_time_ms)||Math.abs(this.now()-message.server_time_ms)>5000||message.server_time_ms<this.startedAt-1000)return {ok:false,reason:'envelope'};
    const key=`${id}/${message.message_id}`;
    if(this.seen.has(key))return {ok:false,reason:'duplicate'};
    this.seen.add(key);
    if(this.seen.size>512)this.seen.delete(this.seen.values().next().value);
    const payload=message.payload??{};
    let entry;
    const actor=this.players.get(id);
    if(message.type==='diagnostic_shot'&&payload.shooter_id===player.shooterId&&Number.isInteger(payload.shot_seq)&&payload.shot_seq>=0&&payload.shot_seq<=255){
      if(!actor||actor.hp===0||this.now()-actor.lastShot<685)return {ok:false,reason:'rate_or_dead'};
      actor.lastShot=this.now();actor.shots++;
      this.shots.push({id,seq:payload.shot_seq,at:this.now(),victims:new Set()});
      entry={type:'shot',playerId:id,playerName:player.name,seq:payload.shot_seq};
    }else if(message.type==='diagnostic_hit'&&receiverIds.includes(payload.receiver_id)){
      const frame=decodeGameFrame(payload.frame);
      const shooter=game.s.players.find(p=>p.shooterId===frame?.shooterId);
      if(!frame||frame.flags!==1||!shooter||shooter.id===id||frame.shooterId!==payload.shooter_id||frame.seq!==payload.shot_seq)return {ok:false,reason:'invalid_ir'};
      const shot=this.shots.findLast(item=>item.id===shooter.id&&item.seq===frame.seq&&this.now()-item.at<=700);
      if(!shot){if(this.pending.length>=64)return {ok:false,reason:'overflow'};this.pending.push({id,message});return {ok:true,pending:true};}
      if(!actor||actor.hp===0||shot.victims.has(id))return {ok:false,reason:'dead_or_duplicate'};
      shot.victims.add(id);actor.hp=0;actor.deaths++;actor.respawnAt=this.now()+7000;
      this.players.get(shooter.id).kills++;
      entry={type:'hit',playerId:id,playerName:player.name,shooterId:shooter.id,shooterName:shooter.name,receiverId:payload.receiver_id,seq:frame.seq};
    }else return {ok:false,reason:'invalid_event'};
    entry.at=this.now();
    this.events.push(entry);
    if(this.events.length>40)this.events.shift();
    this.log({at:entry.at,type:`diagnostic_${entry.type}`,gameId:game.s.id,...entry});
    let changed=entry.type==='hit';
    if(entry.type==='shot'){
      const waiting=this.pending.filter(item=>item.message.payload?.shooter_id===player.shooterId&&item.message.payload?.shot_seq===entry.seq);
      this.pending=this.pending.filter(item=>!waiting.includes(item));
      for(const item of waiting)if(this.acceptPendingHit(game,item.id,item.message).changed)changed=true;
    }
    return {ok:true,entry,changed};
  }
  acceptPendingHit(game,id,message){
    // The shot can arrive after the infrared report; reuse validation with a
    // new envelope identity while keeping the captured payload and timing.
    const retry={...message,message_id:`${message.message_id}/matched`,server_time_ms:this.now()};
    return this.receive(game,id,retry);
  }
  tick(){
    if(!this.enabled)return false;
    const now=this.now();let changed=false;
    for(const player of this.players.values())if(player.hp===0&&now>=player.respawnAt){player.hp=1;player.respawnAt=0;changed=true;const entry={type:'respawn',at:now,playerId:player.id,playerName:player.name};this.events.push(entry);this.log({at:now,type:'diagnostic_respawn',...entry});}
    this.shots=this.shots.filter(shot=>now-shot.at<1200);
    this.pending=this.pending.filter(item=>now-item.message.server_time_ms<700);
    if(this.events.length>40)this.events.splice(0,this.events.length-40);
    return changed;
  }
  state(id){return this.enabled?this.players.get(id)??null:null;}
  view(){return {enabled:this.enabled,startedAt:this.startedAt,events:this.events,players:this.enabled?[...this.players.values()].map(({lastShot,...player})=>player):[],intermissionHeld:this.intermissionRemainingMs!==null};}
}
