import test from 'node:test';
import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

test('legacy trigger discards rapid/busy presses without replay and restores the v3 motor profile', t => {
  const compiler = '.tools/platformio/packages/toolchain-xtensa-esp32s3/bin/xtensa-esp32s3-elf-g++.exe';
  if (!existsSync(compiler)) return t.skip('Install the firmware toolchain with build-firmware.ps1');
  const result = spawnSync(compiler, ['-std=c++14', '-fsyntax-only', 'tests/legacy-motor-compile.cpp'], {encoding:'utf8', windowsHide:true});
  assert.equal(result.status, 0, result.stderr || String(result.error));
});
