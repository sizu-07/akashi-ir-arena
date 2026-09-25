import {spawnSync} from 'node:child_process';
import {writeFileSync, readFileSync, readdirSync, mkdirSync, existsSync} from 'node:fs';
import {createHash} from 'node:crypto';

const revision = '0.7';
const tests = readdirSync('tests').filter(p => p.endsWith('.test.mjs')).map(p => `tests/${p}`);
const test = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...tests], {encoding: 'utf8', windowsHide: true});
mkdirSync('artifacts', {recursive: true});
writeFileSync('artifacts/release-tests.tap', test.stdout + test.stderr);

const readJson = path => existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
const browser = readJson('artifacts/browser/result.json');
const projector = readJson('artifacts/projector/result.json');
const manifest = readJson('firmware/release/v0.7/manifest.json');
const firmwareHashes = readJson('firmware/release/v0.7/sha256.json');
const requiredFiles = ['specs/hardware-profile.json', 'assets/rules.webm'];
const firmwareFiles = ['bootloader.bin', 'partitions.bin', 'boot_app0.bin', 'firmware.bin'];
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const firmwareReady = manifest?.revision === '0.7.0' && manifest.hardwareProfile === JSON.parse(readFileSync(requiredFiles[0], 'utf8')).profile
  && firmwareFiles.every(name => existsSync(`firmware/release/v0.7/${name}`) && firmwareHashes?.[name] === hash(`firmware/release/v0.7/${name}`))
  && Object.entries(manifest.sourceHashes ?? {}).every(([path, expected]) => existsSync(path) && hash(path) === expected);
const sha256 = Object.fromEntries([...requiredFiles, ...(firmwareReady ? firmwareFiles.map(name => `firmware/release/v0.7/${name}`) : [])]
  .filter(existsSync).map(path => [path, hash(path)]));
const softwarePassed = test.status === 0 && browser?.revision === revision && browser.passed === true && projector?.passed === true && requiredFiles.every(existsSync);
const physicalRows = readFileSync('tests/実機試験記録.csv', 'utf8').split(/\r?\n/).filter(line => /^V7-\d+,/.test(line));
const physicalReady = physicalRows.length === 12 && physicalRows.every(line => {
  const fields = line.split(',');
  return fields[3] === '0.7.0' && fields[13] === '合格';
});
const report = {
  revision,
  checkedAt: new Date().toISOString(),
  passed: softwarePassed && firmwareReady && physicalReady,
  softwarePassed,
  testSummary: test.stdout.split('\n').filter(s => /^# (tests|pass|fail|skipped)/.test(s)),
  browser: browser?.revision === revision ? browser : {passed: false, note: 'v0.7 browser test has not been run'},
  projector: projector ?? {passed: false, note: 'Projector browser test has not been run'},
  firmware: firmwareReady ? manifest : {passed: false, note: 'v0.7 firmware binary has not been built/exported'},
  physicalTests: {passed: physicalReady, note: 'Record v0.7 gun hardware and venue tests in tests/実機試験記録.csv'},
  sha256,
};
writeFileSync('artifacts/release-validation.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
