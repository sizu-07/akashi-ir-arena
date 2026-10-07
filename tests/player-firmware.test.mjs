import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {Game} from '../apps/server/game.mjs';
import {hardware} from '../apps/server/hardware.mjs';
test('all four compiled identities reject mismatched settings and preserve real IR IDs and minimal logging',t=>{
  const compiler='.tools/platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-g++.exe';
  if(!existsSync(compiler))return t.skip('Firmware toolchain not installed');
  for(let player=1;player<=4;player++){
    const result=spawnSync(compiler,['-std=c++14',`-DGAME_PLAYER=${player}`,'-fsyntax-only','tests/player-firmware-compile.cpp'],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,`player${player}: ${result.stderr||result.error}`);
  }
});
test('four full game players can report shots, opposing hits and friendly-fire rejection',()=>{
  let now=100000,seq=0;
  const devices=[1,2,3,4].map(n=>({id:`gun-00${n}`,name:`P${n}`,shooterId:n,team:n<=2?'A':'B'}));
  const game=new Game(devices,{now:()=>now});
  const telemetry={hardware_profile:hardware.profile,firmware_version:'0.7.2-4e42',hardware_ready:true,bench:false,lowBattery:false,syncRtt:5};
  for(const p of devices){game.hello(p.id,'boot');game.heartbeat(p.id,telemetry);}
  game.start(true);for(const p of devices)game.ack(p.id,{command_id:game.s.commandId,result:'ok'});
  now=game.s.startAt;for(const p of devices)game.heartbeat(p.id,telemetry);game.tick();
  const event=(id,type,payload)=>game.event(id,{device_id:id,boot_id:'boot',seq:++seq,message_id:String(seq),game_id:game.s.id,game_generation:game.s.generation,server_time_ms:now,type,payload});
  for(const [source,target,ally] of [[1,3,2],[2,4,1],[3,1,4],[4,2,3]]){
    assert.equal(event(`gun-00${source}`,'shot_fired',{shot_seq:source,weapon_id:1}).ok,true);
    const hit={shooter_id:source,shot_seq:source,weapon_id:1,flags:0,receiver_id:'rx1'};
    assert.equal(event(`gun-00${target}`,'hit_candidate',hit).ok,true);
    assert.equal(event(`gun-00${ally}`,'hit_candidate',hit).reason,'friendly');
  }
  assert.deepEqual(game.s.players.map(p=>p.hp),[95,95,95,95]);
});
test('exported player binaries contain their own identity and match manifests and hashes',t=>{
  const hashes=new Set();
  for(let player=1;player<=4;player++){
    const dir=`firmware/release/players-4e/player${player}`;
    if(!existsSync(`${dir}/manifest.json`))return t.skip('Run export-player-firmware.mjs first');
    const manifest=JSON.parse(readFileSync(`${dir}/manifest.json`,'utf8'));
    assert.equal(manifest.player,player);assert.equal(manifest.deviceId,`gun-00${player}`);
    assert.deepEqual(manifest.pins.irRx,[44,7,8]);assert.equal(manifest.pins.led,42);
    const sums=JSON.parse(readFileSync(`${dir}/sha256.json`,'utf8'));
    for(const [file,expected] of Object.entries(sums))assert.equal(createHash('sha256').update(readFileSync(`${dir}/${file}`)).digest('hex'),expected);
    const bin=readFileSync(`${dir}/firmware.bin`);assert.equal(bin.includes(Buffer.from(`gun-00${player}`)),true);
    for(let other=1;other<=4;other++)if(other!==player)assert.equal(bin.includes(Buffer.from(`gun-00${other}`)),false,'Do not embed another player identity');
    hashes.add(sums['firmware.bin']);
  }
  assert.equal(hashes.size,4,'Four binaries must differ by fixed identity');
});
