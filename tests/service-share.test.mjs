import test from 'node:test';
import assert from 'node:assert/strict';
import {Game} from '../apps/server/game.mjs';
import {hardware} from '../apps/server/hardware.mjs';
import {TicketQueue} from '../apps/ticket-server/tickets.mjs';
import {createShare, publicShare, SHARE_TTL_MS} from '../apps/ticket-server/shares.mjs';

const devices = [1, 2, 3, 4].map(n => ({id:`gun-00${n}`,name:`P${n}`,shooterId:n}));
const telemetry = {syncRtt:10,hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.8.2-4e42',bench:false};
function fixture() {
  let now = 100000;
  const g = new Game(devices,{now:()=>now});
  for(const p of devices){g.hello(p.id,'boot');g.heartbeat(p.id,telemetry);}
  return {g,advance(ms){now+=ms;for(const p of devices)g.heartbeat(p.id,telemetry);g.tick(true);},
    start(){g.start(true);for(const id of g.s.participantIds)g.ack(id,{command_id:g.s.commandId,result:'ok'});this.advance(7010);}};
}

test('a broken gun can be taken out of service and the match continues with the remaining guns',()=>{
  const f=fixture();
  f.g.setOutOfService('gun-003',true);
  f.start();
  assert.equal(f.g.s.phase,'ACTIVE');
  assert.deepEqual(f.g.s.participantIds,['gun-001','gun-002','gun-004']);
  assert.equal(f.g.player('gun-003').armed,false);
  // 試合中に故障しても一時停止せず、その銃だけ外れる。
  f.g.setOutOfService('gun-004',true);
  assert.equal(f.g.s.phase,'ACTIVE');
  assert.deepEqual(f.g.s.participantIds,['gun-001','gun-002']);
  // 2台未満になると続けられないので一時停止する。
  f.g.setOutOfService('gun-002',true);
  assert.equal(f.g.s.phase,'PAUSED');
  assert.equal(f.g.s.pauseReason,'使用できる銃が不足');
  assert.throws(()=>f.g.start(true),/2台未満/);
  // 使用を再開した銃は再開時から参加する。
  f.g.setOutOfService('gun-002',false);
  f.g.start(true);
  assert.deepEqual(f.g.s.participantIds,['gun-001','gun-002']);
});

test('a gun returned to service rejoins from the next game and keeps earlier kills',()=>{
  const f=fixture();f.start();
  f.g.player('gun-003').kills=2;
  f.g.setOutOfService('gun-003',true);
  f.advance(86000);
  assert.equal(f.g.s.phase,'INTERMISSION');
  f.g.setOutOfService('gun-003',false);
  f.g.start(true,{automatic:true});
  assert.deepEqual(f.g.s.participantIds,['gun-001','gun-002','gun-003','gun-004']);
  assert.equal(f.g.player('gun-003').kills,2);
});

test('share pages show only the viewer name, are idempotent per match and expire after seven days',()=>{
  let now=1_000_000;
  const queue=new TicketQueue({now:()=>now});
  const input={gameId:'match-1',rounds:3,draw:false,players:[
    {slot:1,name:'あかし',rank:1,kills:5,deaths:1,shots:9,accuracy:55.6,winner:true},
    {slot:2,name:'こうせん',rank:2,kills:3,deaths:2,shots:8,accuracy:37.5},
    {slot:3,name:'たろう',rank:3,kills:1,deaths:4,shots:5,accuracy:20},
    {slot:4,name:'はなこ',rank:4,kills:0,deaths:2,shots:3,accuracy:0}]};
  const record=createShare(queue,input);
  assert.equal(createShare(queue,input).id,record.id);
  const view=publicShare(queue,record.players[1].token);
  assert.equal(view.me,2);
  assert.deepEqual(view.players.map(p=>p.name),['プレイヤー1','こうせん','プレイヤー3','プレイヤー4']);
  assert.ok(view.players.every(p=>!('token' in p)));
  assert.equal(publicShare(queue,'x'.repeat(24)),null);
  assert.throws(()=>createShare(queue,{gameId:'bad',players:[{slot:5}]}),/プレイヤー番号/);
  now+=SHARE_TTL_MS+1;
  assert.equal(publicShare(queue,record.players[0].token),null);
});
