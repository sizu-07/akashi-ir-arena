import test from 'node:test';
import assert from 'node:assert/strict';
import {Game,defaults,rulesOf} from '../apps/server/game.mjs';
import {hardware} from '../apps/server/hardware.mjs';

const devices=[1,2,3,4].map(n=>({id:`gun-00${n}`,name:`P${n}`,team:n<3?'A':'B',shooterId:n}));
const telemetry={syncRtt:10,hardware_profile:hardware.profile,hardware_ready:true,bench:false,lowBattery:false};
function fixture(saved=null){
  let now=100000,seq=0;const logs=[];const g=new Game(devices,{now:()=>now,log:e=>logs.push(e),saved});
  for(const p of devices){g.hello(p.id,'boot');g.heartbeat(p.id,telemetry);}
  const f={g,logs,now:()=>now,advance(ms){now+=ms;for(const p of devices)g.heartbeat(p.id,telemetry);g.tick();},
    start(){g.start(true);for(const p of devices)g.ack(p.id,{command_id:g.s.commandId,result:'ok'});this.advance(7010);},
    event(id,type,payload){return {device_id:id,boot_id:'boot',game_id:g.s.id,game_generation:g.s.generation,message_id:String(++seq),seq,server_time_ms:now,type,payload};},
    send(id,type,payload){return g.event(id,this.event(id,type,payload));},
    fire(id,shot_seq){return this.send(id,'shot_fired',{shot_seq,weapon_id:1});},
    hit(id,shooter_id,shot_seq,flags=0,receiver_id='rx1'){return this.send(id,'hit_candidate',{shooter_id,shot_seq,weapon_id:1,flags,receiver_id});}};
  return f;
}

test('new rules use five damage, one second between presses and no ammo or reload',()=>{
  assert.equal(defaults.damage,5);assert.equal(defaults.fireMs,1000);assert.equal(defaults.reviveMs,3000);
  assert.equal('magazine' in rulesOf(),false);assert.equal('reloadMs' in rulesOf(),false);
  assert.throws(()=>rulesOf({fireMs:900}));assert.throws(()=>rulesOf({reviveHp:101}));
  const f=fixture();f.start();assert.equal(f.fire('gun-001',1).ok,true);
  f.advance(500);assert.equal(f.fire('gun-001',2).reason,'rate');
  f.advance(500);assert.equal(f.fire('gun-001',3).ok,true);
  assert.equal(f.send('gun-001','reload_started',{}).reason,'unknown_type');
  assert.equal('ammo' in f.g.player('gun-001'),false);
});

test('three receivers report one attack only once and only PC-approved damage vibrates',()=>{
  const f=fixture();f.start();f.fire('gun-001',1);
  for(const rx of ['rx2','rx1','rx3'])f.hit('gun-003',1,1,0,rx);
  const p=f.g.player('gun-003');assert.equal(p.hp,95);assert.equal(p.lastReceiver,'rx2');
  assert.equal(f.logs.filter(x=>x.type==='hit').length,1);
  assert.equal(p.damageFeedback.duration_ms,180);
  assert.equal(f.hit('gun-002',1,1).reason,'friendly');
  assert.equal(f.hit('gun-003',1,1,1).reason,'revive_invalid');
});

test('candidate arriving before shot is matched, but a later combat repeat cannot hit again',()=>{
  const f=fixture();f.start();assert.equal(f.hit('gun-003',1,4).reason,'pending');
  f.fire('gun-001',4);assert.equal(f.g.player('gun-003').hp,95);
  f.advance(350);assert.equal(f.hit('gun-003',1,4).reason,'duplicate_hit');
  assert.equal(f.g.player('gun-003').hp,95);
});

test('only a live teammate holding the same shot for three seconds can revive',()=>{
  const f=fixture();f.start();const victim=f.g.player('gun-002');victim.hp=0;victim.deadAt=f.now();
  f.fire('gun-001',7);
  for(let elapsed=0;elapsed<=3000;elapsed+=500){
    if(elapsed)f.advance(500);
    f.send('gun-001','shot_hold',{shot_seq:7});
    const result=f.hit('gun-002',1,7,1);
    if(elapsed<3000){assert.equal(result.ok,true);assert.equal(victim.hp,0);}
    else {assert.equal(result.revived,true);assert.equal(victim.hp,50);}
  }
  assert.equal(victim.reviveProgressMs,0);
  assert.equal(f.logs.filter(x=>x.type==='revive').length,1);
  assert.equal(f.g.s.score.A,0);
});

test('rescue progress resets after lost aim and never revives an enemy',()=>{
  const f=fixture();f.start();f.g.player('gun-002').hp=0;f.g.player('gun-003').hp=0;
  f.fire('gun-001',8);f.send('gun-001','shot_hold',{shot_seq:8});
  assert.equal(f.hit('gun-003',1,8,1).reason,'revive_invalid');
  f.hit('gun-002',1,8,1);f.advance(800);f.send('gun-001','shot_hold',{shot_seq:8});
  assert.equal(f.hit('gun-002',1,8,1).progressMs,0);
  f.send('gun-001','shot_released',{shot_seq:8});
  assert.equal(f.g.player('gun-002').reviveProgressMs,0);
  assert.equal(f.send('gun-001','shot_hold',{shot_seq:8}).reason,'hold_ended');
  f.advance(500);
  assert.notEqual(f.hit('gun-002',1,8,1).ok,true);
  assert.equal(f.g.player('gun-002').hp,0);
});

test('a lethal hit scores once and a defeated shooter cannot start a rescue shot',()=>{
  const f=fixture();f.start();f.g.player('gun-003').hp=5;f.fire('gun-001',2);
  assert.equal(f.hit('gun-003',1,2).hp,0);assert.equal(f.g.s.score.A,1);
  assert.equal(f.hit('gun-003',1,2).reason,'dead');
  f.advance(1000);assert.equal(f.fire('gun-003',9).reason,'dead');
  assert.equal(f.g.s.score.A,1);
});

test('pause, resume and connection safety retain time and clear rescue progress',()=>{
  const f=fixture();f.start();f.g.player('gun-002').hp=0;f.fire('gun-001',1);f.hit('gun-002',1,1,1);
  f.advance(500);f.send('gun-001','shot_hold',{shot_seq:1});f.hit('gun-002',1,1,1);
  assert.equal(f.g.player('gun-002').reviveProgressMs,500);
  const remaining=f.g.s.remainingMs;f.g.pause();assert.equal(f.g.player('gun-002').reviveProgressMs,0);
  f.advance(2000);assert.equal(f.g.s.remainingMs,remaining);f.start();assert.equal(f.g.s.phase,'ACTIVE');
  f.g.player('gun-001').lastSeen-=4000;f.g.tick();assert.equal(f.g.s.phase,'PAUSED');
});

test('start needs projector and four current devices; expired game ranks score then HP',()=>{
  const f=fixture();assert.throws(()=>f.g.start(false));f.g.player('gun-001').connected=false;assert.throws(()=>f.g.start(true));
  f.g.hello('gun-001','boot');f.g.heartbeat('gun-001',telemetry);f.start();
  f.g.player('gun-003').hp=95;f.advance(300001);assert.equal(f.g.s.phase,'FINISHED');assert.equal(f.g.s.winner,'A');
});

test('saved v0.6 rounds migrate to v0.7 rules without old ammo state',()=>{
  const f=fixture();const saved=f.g.view();saved.rules={hp:100,damage:25,durationSec:300,magazine:30,fireMs:200,reloadMs:2000,invulnerableMs:300,friendlyFire:false};
  for(const p of saved.players){p.ammo=30;p.reloadUntil=0;}
  const restored=fixture(saved);assert.equal(restored.g.s.rules.damage,5);assert.equal(restored.g.s.rules.fireMs,1000);
  assert.equal('ammo' in restored.g.view().players[0],false);
});
