import test from 'node:test';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';import {hardware} from '../apps/server/hardware.mjs';
test('v0.6 pin profile avoids S3 strapping, USB and memory pins; RMT directions fit',()=>{
 const p=hardware,pins=[...p.receivers,...Object.values(p.inputs),...Object.values(p.outputs)].map(x=>x.gpio);
 assert.equal(new Set(pins).size,11);assert.ok(pins.every(x=>![0,3,19,20,26,27,28,29,30,31,32,33,34,35,36,37,45,46].includes(x)));
 assert.deepEqual(p.receivers.map(x=>x.rmt),[4,5,6]);assert.equal(p.outputs.ir.rmt,0);assert.equal(p.outputs.led.rmt,1);
 const r=spawnSync(process.execPath,['tools/generate-firmware-profile.mjs','--check'],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const cpp=readFileSync('firmware/src/main.cpp','utf8');assert.ok(cpp.includes('#include "hardware_profile.h"'));assert.ok(cpp.includes('esp_timer_start_once'));
});
test('firmware feedback state machine passes C++ constant-evaluation tests',t=>{
 const compiler='.tools/platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-g++.exe';
 if(!existsSync(compiler))return t.skip('Install the firmware toolchain with build-firmware.ps1');
 const r=spawnSync(compiler,['-std=c++14','-fsyntax-only','tests/feedback-compile.cpp'],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr||String(r.error));
});
