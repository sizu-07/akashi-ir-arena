import test from 'node:test';
import assert from 'node:assert/strict';
import {Game, defaults, rulesOf, intermissionDurationMs} from '../apps/server/game.mjs';
import {hardware} from '../apps/server/hardware.mjs';

const devices = [1, 2, 3, 4].map(n => ({id:`gun-00${n}`,name:`P${n}`,shooterId:n}));
const telemetry = {syncRtt:10,hardware_profile:hardware.profile,hardware_ready:true,firmware_version:'0.8.0-4e42',bench:false,lowBattery:false};
function fixture(saved = null, options = {}) {
  let now = 100000, seq = 0;
  const logs = [];
  const g = new Game(devices,{now:()=>now,log:e=>logs.push(e),saved,...options});
  for(const p of devices){g.hello(p.id,'boot');g.heartbeat(p.id,telemetry);}
  const f = {g,logs,now:()=>now,
    advance(ms, displayReady=true){now+=ms;for(const p of devices)g.heartbeat(p.id,telemetry);g.tick(displayReady);},
    start(){g.start(true);for(const p of devices)g.ack(p.id,{command_id:g.s.commandId,result:'ok'});this.advance(7010);},
    send(id,type,payload){const message={device_id:id,boot_id:'boot',game_id:g.s.id,game_generation:g.s.generation,message_id:String(++seq),seq,server_time_ms:now,type,payload};return g.event(id,message);},
    fire(id,shot_seq){return this.send(id,'shot_fired',{shot_seq,weapon_id:1});},
    hit(id,shooter_id,shot_seq,flags=0,receiver_id='rx1'){return this.send(id,'hit_candidate',{shooter_id,shot_seq,weapon_id:1,flags,receiver_id});}
  };
  return f;
}

test('three 85-second games display 90 seconds, with 700 ms shots and seven-second respawn',()=>{
  assert.deepEqual(defaults,{mode:'FFA_KILLS_V1',rounds:3,durationSec:85,displayDurationSec:90,fireMs:700,respawnMs:7000});
  assert.deepEqual(rulesOf(),defaults);
  assert.throws(()=>rulesOf({rounds:4}));
  assert.throws(()=>rulesOf({respawnMs:5000}));
  const f=fixture();f.start();
  assert.equal(f.fire('gun-001',1).ok,true);
  f.advance(500);assert.equal(f.fire('gun-001',2).reason,'rate');
  f.advance(200);assert.equal(f.fire('gun-001',3).ok,true);
  assert.equal(f.send('gun-001','shot_hold',{shot_seq:3}).reason,'unsupported');
});

test('all four players are opponents; one accepted hit kills once and credits the shooter',()=>{
  const f=fixture();f.start();f.fire('gun-001',1);
  const result=f.hit('gun-002',1,1);
  assert.equal(result.kill,true);
  assert.equal(f.g.player('gun-002').hp,0);
  assert.equal(f.g.player('gun-002').deaths,1);
  assert.equal(f.g.player('gun-001').kills,1);
  assert.equal(f.g.player('gun-001').accuracy,100);
  assert.equal(f.hit('gun-002',1,1,0,'rx2').reason,'dead');
  assert.equal(f.g.player('gun-001').kills,1);
  assert.equal(f.fire('gun-002',7).reason,'dead');
  assert.equal(f.hit('gun-001',1,1).reason,'invalid_ir');
  assert.equal(f.hit('gun-003',1,1,1).reason,'invalid_ir');
});

test('candidate before shot can match; one shot can kill two opponents but accuracy stays within 100%',()=>{
  const f=fixture();f.start();
  assert.equal(f.hit('gun-002',1,1).reason,'pending');
  assert.equal(f.fire('gun-001',1).ok,true);
  assert.equal(f.g.player('gun-002').hp,0);
  assert.equal(f.hit('gun-003',1,1).ok,true);
  assert.equal(f.g.player('gun-001').kills,2);
  assert.equal(f.g.player('gun-001').hits,2);
  assert.equal(f.g.player('gun-001').accuracy,100);
});

test('defeated player respawns automatically at seven seconds without score loss',()=>{
  const f=fixture();f.start();f.fire('gun-001',1);f.hit('gun-002',1,1);
  assert.equal(f.g.player('gun-002').respawnAt,f.now()+7000);
  f.advance(6999);assert.equal(f.g.player('gun-002').hp,0);
  f.advance(1);assert.equal(f.g.player('gun-002').hp,1);
  assert.equal(f.g.player('gun-002').deaths,1);
  assert.equal(f.g.player('gun-001').kills,1);
  assert.deepEqual(f.g.view().soundEvents.map(e=>e.kind),['shot','defeat','revive']);
});

test('pause freezes round clock and respawn countdown until resumed',()=>{
  const f=fixture();f.start();f.fire('gun-001',1);f.hit('gun-002',1,1);
  f.advance(2000);const remaining=f.g.s.remainingMs;f.g.pause();
  assert.equal(f.g.view().pauseReason,'operator');
  assert.equal(f.g.player('gun-002').respawnRemainingMs,5000);
  f.advance(30000);assert.equal(f.g.s.remainingMs,remaining);
  f.start();assert.equal(f.g.view().pauseReason,null);f.advance(4999);assert.equal(f.g.player('gun-002').hp,0);
  f.advance(1);assert.equal(f.g.player('gun-002').hp,1);
  f.g.player('gun-001').lastSeen-=4000;f.g.tick();assert.equal(f.g.s.phase,'PAUSED');assert.equal(f.g.view().pauseReason,'端末通信断');
});

test('saved 120-second match resumes with elapsed time on the 85-second clock',()=>{
  const f=fixture();f.start();f.advance(30000);f.g.pause();
  const saved=structuredClone(f.g.s);
  saved.rules.durationSec=120;
  saved.remainingMs=90000;
  const restored=new Game(devices,{saved,now:f.now});
  assert.equal(restored.s.rules.durationSec,85);
  assert.equal(restored.s.rules.displayDurationSec,90);
  assert.equal(restored.s.remainingMs,55000);
  assert.equal(restored.s.phase,'PAUSED');
});

test('saved four-game match ends at round three without counting round four',()=>{
  const f=fixture();f.start();
  for(let round=1;round<=3;round++){
    f.fire('gun-001',round);f.hit('gun-002',1,round);
    f.advance(f.g.s.remainingMs);
    if(round<3)f.start();
  }
  const saved=structuredClone(f.g.s);
  saved.rules.rounds=4;saved.round=4;saved.phase='ACTIVE';saved.roundStart=Object.fromEntries(saved.players.map(p=>[p.id,{kills:p.kills,deaths:p.deaths,shots:p.shots,hits:p.hits,hitShots:p.hitShots}]));
  saved.players[2].kills=9;
  const restored=new Game(devices,{saved,now:f.now});
  assert.equal(restored.s.rules.rounds,3);
  assert.equal(restored.s.phase,'FINISHED');
  assert.equal(restored.s.round,3);
  assert.equal(restored.s.roundResults.length,3);
  assert.equal(restored.s.players[2].kills,0);
  assert.equal(restored.s.winner,'gun-001');
});

test('two intermediate standings and winner from three-game total kills',()=>{
  const f=fixture();f.start();
  for(let round=1;round<=3;round++){
    f.fire('gun-001',round);f.hit('gun-002',1,round);
    f.advance(f.g.s.remainingMs);
    assert.equal(f.g.s.roundResults.length,round);
    assert.equal(f.g.s.roundResults.at(-1).players[0].kills,1);
    if(round<3){assert.equal(f.g.s.phase,'INTERMISSION');assert.equal(f.g.s.round,round+1);f.start();}
  }
  assert.equal(f.g.s.phase,'FINISHED');
  assert.equal(f.g.s.winner,'gun-001');
  assert.equal(f.g.player('gun-001').kills,3);
  assert.equal(f.g.player('gun-002').deaths,3);
  assert.equal(f.g.player('gun-001').shots,3);
  assert.equal(f.g.player('gun-001').accuracy,100);
});

test('production advances after 15 seconds, waits for a ready display, and preserves the next round',()=>{
  const f=fixture(null,{autoAdvanceRounds:true});f.start();
  f.fire('gun-001',1);f.hit('gun-002',1,1);
  f.advance(90000);
  assert.equal(f.g.s.phase,'INTERMISSION');
  assert.equal(f.g.s.intermissionEndsAt,f.now()+intermissionDurationMs);
  assert.throws(()=>f.g.start(true),/自動開始/);
  f.advance(intermissionDurationMs-1);
  assert.equal(f.g.s.phase,'INTERMISSION');
  f.advance(1,false);
  assert.match(f.g.s.intermissionBlockedReason,/投影画面/);
  f.advance(0,true);
  assert.equal(f.g.s.phase,'COUNTDOWN');
  assert.equal(f.g.s.round,2);
  for(const p of devices)f.g.ack(p.id,{command_id:f.g.s.commandId,result:'ok'});
  f.advance(7010);
  assert.equal(f.g.s.phase,'ACTIVE');
  assert.equal(f.g.player('gun-001').kills,1);
  assert.equal(f.g.player('gun-002').hp,1);
});

test('force finish ends the whole match from an active round or intermission',()=>{
  const f=fixture(null,{autoAdvanceRounds:true});f.start();
  f.fire('gun-001',1);f.hit('gun-002',1,1);
  f.g.finish();
  assert.equal(f.g.s.phase,'FINISHED');
  assert.equal(f.g.s.roundResults.length,1);
  assert.equal(f.g.s.winner,'gun-001');
  f.advance(300000);
  assert.equal(f.g.s.phase,'FINISHED');
  const second=fixture(null,{autoAdvanceRounds:true});second.start();second.g.endRound('demo_skip');
  second.g.finish();
  assert.equal(second.g.s.phase,'FINISHED');
  assert.equal(second.g.s.round,1);
  assert.equal(second.g.s.roundResults.length,1);
});

test('equal top kill totals produce a draw; deaths do not break the tie',()=>{
  const f=fixture();f.start();
  f.fire('gun-001',1);f.hit('gun-002',1,1);
  f.fire('gun-003',1);f.hit('gun-001',3,1);
  for(let round=1;round<=3;round++){
    f.advance(f.g.s.remainingMs);
    if(round<3)f.start();
  }
  assert.equal(f.g.s.winner,'DRAW');
});

test('old saved team/HP game migrates to fresh four-player rules',()=>{
  const old={rules:{durationSec:300,hp:100},players:devices.map((d,i)=>({...d,name:`旧名${i+1}`,hp:100,team:i<2?'A':'B'}))};
  const f=fixture(old);
  assert.equal(f.g.s.phase,'LOBBY');
  assert.equal(f.g.s.players[0].name,'旧名1');
  assert.equal(f.g.s.players[0].hp,1);
  assert.equal(f.g.s.players[0].team,undefined);
  assert.equal(f.g.s.rules.mode,'FFA_KILLS_V1');
});

test('normal match rejects firmware with the former team rule',()=>{
  const f=fixture();
  f.g.player('gun-001').firmwareVersion='0.7.4-4e42';
  assert.throws(()=>f.g.start(true),/v0.8/);
});
