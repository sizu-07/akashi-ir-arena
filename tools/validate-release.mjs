import {spawnSync} from 'node:child_process';
import {writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';

const revision = '0.8';
const tests = readdirSync('tests').filter(p => p.endsWith('.test.mjs')).map(p => `tests/${p}`);
const test = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {encoding: 'utf8', windowsHide: true});
mkdirSync('artifacts', {recursive: true});
writeFileSync('artifacts/release-tests.tap', test.stdout + test.stderr);

const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const browser = readJson('artifacts/browser/result.json');
const projector = readJson('artifacts/projector/result.json');
const guest = readJson('artifacts/guest-ui/result.json');
const requiredFiles = ['specs/hardware-profile.json', 'assets/rules.webm'];
const firmwareFiles = ['bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const profile = JSON.parse(readFileSync(requiredFiles[0], 'utf8')).profile;
const firmware = [1,2,3,4].map(player => {
  const base = `firmware/release/players-4e/player${player}`;
  const manifest = readJson(`${base}/manifest.json`);
  const hashes = readJson(`${base}/sha256.json`);
  const passed = manifest?.firmwareVersion === '0.8.2-4e42' && manifest.player === player
    && manifest.deviceId === `gun-00${player}` && manifest.shooterId === player && manifest.hardwareProfile === profile
    && firmwareFiles.every(name => existsSync(`${base}/${name}`) && hashes?.[name] === hash(`${base}/${name}`))
    && Object.entries(manifest.sourceHashes ?? {}).length > 0
    && Object.entries(manifest.sourceHashes ?? {}).every(([path, expected]) => existsSync(path) && hash(path) === expected);
  return {player,passed,firmwareVersion:manifest?.firmwareVersion ?? null};
});
const firmwareReady = firmware.every(item => item.passed);
const sha256 = Object.fromEntries([...requiredFiles, ...(firmwareReady ? [1,2,3,4].flatMap(player => firmwareFiles.map(name => `firmware/release/players-4e/player${player}/${name}`)) : [])]
  .filter(existsSync).map(path => [path, hash(path)]));
const softwarePassed = test.status === 0 && browser?.revision === revision && browser.passed === true
  && projector?.revision === revision && projector.passed === true && guest?.revision === revision && guest.passed === true
  && requiredFiles.every(existsSync);
const physicalRows = readFileSync('tests/実機試験記録.csv', 'utf8').split(/\r?\n/).filter(line => /^V8-\d+,/.test(line));
const physicalReady = physicalRows.length === 9 && physicalRows.every(line => {
  const fields = line.split(',');
  return fields[3] === '0.8.2-4e42' && fields[13] === '合格';
});
const report = {
  revision,
  checkedAt: new Date().toISOString(),
  passed: softwarePassed && firmwareReady && physicalReady,
  softwarePassed,
  testSummary: test.stdout.split('\n').filter(s => /^# (tests|pass|fail|skipped)/.test(s)),
  browser: browser?.revision === revision ? browser : {passed: false, note: 'v0.8 operator browser test has not been run'},
  projector: projector?.revision === revision ? projector : {passed: false, note: 'v0.8 projector browser test has not been run'},
  guest: guest?.revision === revision ? guest : {passed: false, note: 'v0.8 ticket guest browser test has not been run'},
  firmware,
  physicalTests: {passed: physicalReady, completed: physicalRows.filter(line => line.split(',')[13] === '合格').length, required: 9, note: 'Record v0.8.2 four-player hardware, diagnostics and venue tests in tests/実機試験記録.csv'},
  sha256,
};
writeFileSync('artifacts/release-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
