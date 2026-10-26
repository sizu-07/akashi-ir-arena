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
  }
  begin(game) {
    if(this.enabled)throw Error('一時診断はすでに実行中です');
    if(!game.s.players.some(p=>p.connected&&p.diagnosticCapable))throw Error('診断対応ファームウェアの接続端末がありません。端末を更新・接続してください');
    if(game.s.phase==='ACTIVE'||game.s.phase==='COUNTDOWN')game.pause('一時診断中');
    if(game.s.phase==='INTERMISSION'&&Number.isFinite(game.s.intermissionEndsAt)){
      this.intermissionRemainingMs=Math.max(0,game.s.intermissionEndsAt-this.now());
      game.s.intermissionEndsAt=null;
    }
    this.enabled=true;
    this.startedAt=this.now();
    this.events=[];
    this.seen.clear();
    this.log({at:this.startedAt,type:'diagnostic_start',gameId:game.s.id,phase:game.s.phase});
  }
  end(game) {
    if(!this.enabled)throw Error('一時診断は実行されていません');
    this.enabled=false;
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
    if(message.type==='diagnostic_shot'&&payload.shooter_id===player.shooterId&&Number.isInteger(payload.shot_seq)&&payload.shot_seq>=0&&payload.shot_seq<=255){
      entry={type:'shot',playerId:id,playerName:player.name,seq:payload.shot_seq};
    }else if(message.type==='diagnostic_hit'&&receiverIds.includes(payload.receiver_id)){
      const frame=decodeGameFrame(payload.frame);
      const shooter=game.s.players.find(p=>p.shooterId===frame?.shooterId);
      if(!frame||frame.flags!==1||!shooter||shooter.id===id||frame.shooterId!==payload.shooter_id||frame.seq!==payload.shot_seq)return {ok:false,reason:'invalid_ir'};
      entry={type:'hit',playerId:id,playerName:player.name,shooterId:shooter.id,shooterName:shooter.name,receiverId:payload.receiver_id,seq:frame.seq};
    }else return {ok:false,reason:'invalid_event'};
    entry.at=this.now();
    this.events.push(entry);
    if(this.events.length>40)this.events.shift();
    this.log({at:entry.at,type:`diagnostic_${entry.type}`,gameId:game.s.id,...entry});
    return {ok:true,entry};
  }
  view(){return {enabled:this.enabled,startedAt:this.startedAt,events:this.events,intermissionHeld:this.intermissionRemainingMs!==null};}
}
