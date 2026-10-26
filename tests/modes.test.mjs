import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import mqtt from 'mqtt';
import WebSocket from 'ws';
import {createApp} from '../apps/server/main.mjs';
import {Game} from '../apps/server/game.mjs';
import {storage} from '../apps/server/store.mjs';
import {hardware} from '../apps/server/hardware.mjs';

const devices = [1, 2, 3, 4].map(n => ({id: `gun-00${n}`, key: `test-key-${n}`, name: `P${n}`, shooterId: n}));
const config = {httpPort: 0, mqttPort: 0, operatorPin: '12345678', devices};
const waitFor = async predicate => {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error('状態の更新待ちがタイムアウトしました');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
};
async function login(app) {
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  const response = await fetch(`${base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pin: config.operatorPin})});
  const session = await response.json(), cookie = response.headers.get('set-cookie').split(';')[0];
  let sequence = 0;
  return {base, action: (action, extra = {}) => fetch(`${base}/api/action`, {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': session.csrf}, body: JSON.stringify({action, commandId: `mode-test-${++sequence}`, ...extra})})};
}
async function prepareDisplay(base, app) {
  const display = new WebSocket(`${base.replace('http:', 'ws:')}/ws/display`, {headers: {Origin: base}});
  await new Promise((resolve, reject) => {display.once('open', resolve); display.once('error', reject);});
  display.send(JSON.stringify({type: 'ready', ready: true}));
  await new Promise(resolve => display.once('message', resolve));
  // Wait for the HTTP view to confirm the same readiness gate used by start.
  while (!(await (await fetch(`${base}/api/state`)).json()).displayReady) await new Promise(resolve => setTimeout(resolve, 25));
  return display;
}
async function connectDevice(app, n, {lowBattery = false} = {}) {
  const device = devices[n - 1], boot = `boot-${n}`, topic = `irgame/v1/device/${device.id}`;
  const client = mqtt.connect(`mqtt://127.0.0.1:${app.mqttServer.address().port}`, {clientId: device.id, username: device.id, password: device.key, reconnectPeriod: 0});
  await new Promise((resolve, reject) => {client.once('connect', resolve); client.once('error', reject);});
  let sequence = 0;
  client.on('message', (name, raw) => {
    const desired = JSON.parse(raw);
    if (name.endsWith('/desired') && desired.phase === 'COUNTDOWN') client.publish(`${topic}/event`, JSON.stringify({device_id: device.id, boot_id: boot, seq: ++sequence, message_id: `${boot}-${sequence}`, game_id: desired.game_id, game_generation: desired.game_generation, type: 'command_ack', payload: {command_id: desired.command_id, result: 'ok'}}), {qos: 1});
  });
  await client.subscribeAsync(`${topic}/desired`, {qos: 1});
  await client.publishAsync(`${topic}/hello`, JSON.stringify({boot_id: boot}), {qos: 1});
  await client.publishAsync(`${topic}/telemetry`, JSON.stringify({boot_id: boot, hardware_profile: hardware.profile, hardware_ready: true, firmware_version: '0.8.0-4e42', bench: false, lowBattery, battery: lowBattery ? 6.8 : 9, syncRtt: 5, device_time_ms: 1}), {qos: 1});
  return client;
}

test('本番は動作確認APIを拒否し、4台の準備とACK後に通常試合・整理券連携を実行する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-production-modes-')), clients = [], events = [];
  const tickets = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    if (req.url === '/api/game/events') events.push(JSON.parse(body).type);
    res.writeHead(200, {'Content-Type': 'application/json'});
    res.end(JSON.stringify(req.url === '/api/game/current-round' ? {roundId: 'round-1', ready: true, playerNicknames: ['One', 'Two', 'Three', 'Four']} : {ok: true}));
  });
  await new Promise(resolve => tickets.listen(0, '127.0.0.1', resolve));
  const app = await createApp({config: {...config, ticketServerUrl: `http://127.0.0.1:${tickets.address().port}`, ticketServerApiKey: 'test-ticket-key'}, dataDir: dir, bind: '127.0.0.1'});
  let display, now = Date.now(); app.game.now = () => now;
  try {
    const {base, action} = await login(app);
    for (const [name, extra] of [['start', {testMode: true}], ['demo_source', {source: 'devices'}], ['motor_demo_hit', {id: 'gun-001'}], ['motor_demo_defeat', {id: 'gun-001'}], ['motor_demo_revive', {id: 'gun-001'}], ['demo_hit', {}]]) assert.equal((await action(name, extra)).status, 400, name);
    assert.throws(() => app.game.start(true, {testMode: true}), /デモ/);
    assert.equal((await action('start')).status, 400, '本番の整理券メンバー反映が必要');
    assert.equal((await action('sync_ticket_members')).status, 200);
    display = await prepareDisplay(base, app);
    clients.push(await connectDevice(app, 1));
    assert.equal((await action('start')).status, 400, '1台では通常試合を開始できない');
    for (const n of [2, 3, 4]) clients.push(await connectDevice(app, n));
    app.game.heartbeat('gun-001', {hardware_profile: hardware.profile, hardware_ready: true, firmware_version:'0.8.0-4e42', syncRtt: 5, lowBattery: true});
    assert.equal((await action('start')).status, 400, '本番では電池保護を解除しない');
    app.game.heartbeat('gun-001', {hardware_profile: hardware.profile, hardware_ready: true, firmware_version:'0.8.0-4e42', syncRtt: 5, lowBattery: false});
    assert.equal((await action('start')).status, 200);
    assert.equal(app.game.s.testMode, false);
    assert.equal(app.game.s.participantIds.length, 4);
    await waitFor(() => app.game.s.startCommitted);
    now = app.game.s.startAt;
    for (const p of app.game.s.players) p.lastSeen = now;
    await waitFor(() => app.game.s.phase === 'ACTIVE');
    await waitFor(() => events.includes('GAME_STARTED'));
    assert.equal(app.game.s.players.every(p => p.armed && !app.game.batteryOverride(p)), true);
    assert.equal((await action('finish')).status, 200);
    assert.equal(app.game.s.phase, 'FINISHED');
    assert.equal(app.game.s.roundResults.length, 1);
    assert.equal(app.game.s.winner, 'DRAW');
    await waitFor(() => events.includes('GAME_ENDED'));
  } finally {
    display?.terminate(); await Promise.all(clients.map(client => client.endAsync(true))); await app.close();
    await new Promise(resolve => tickets.close(resolve)); rmSync(dir, {recursive: true, force: true});
  }
});

test('デモは仮想端末を停止して実機1台を確認でき、通常試合と整理券通信を行わない', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-demo-modes-')), requests = [];
  const tickets = http.createServer((req, res) => {requests.push(req.url); res.end('{}');});
  await new Promise(resolve => tickets.listen(0, '127.0.0.1', resolve));
  const app = await createApp({config: {...config, ticketServerUrl: `http://127.0.0.1:${tickets.address().port}`, ticketServerApiKey: 'test-ticket-key'}, demo: true, dataDir: dir, bind: '127.0.0.1'});
  let client, display, now = Date.now(); app.game.now = () => now;
  try {
    const {base, action} = await login(app);
    await waitFor(() => app.game.s.players.every(p => p.hardwareReady));
    assert.equal((await action('demo_source', {source: 'devices'})).status, 200);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.simulation, false); assert.equal(state.ticketBridge.enabled, false);
    assert.equal(state.players.every(p => !p.connected && p.battery === null && !p.firmwareVersion), true);
    client = await connectDevice(app, 1, {lowBattery: true});
    display = await prepareDisplay(base, app);
    assert.equal((await action('start')).status, 400, '実機デモは動作確認だけを開始できる');
    assert.equal((await action('demo_hit')).status, 400);
    assert.equal((await action('start', {testMode: true})).status, 200);
    assert.deepEqual(app.game.s.participantIds, ['gun-001']);
    assert.equal(app.game.batteryOverride(app.game.player('gun-001')), true);
    assert.equal((await action('demo_source', {source: 'simulation'})).status, 400, 'カウントダウン中に確認対象を変えない');
    await waitFor(() => app.game.s.startCommitted);
    now = app.game.s.startAt; app.game.player('gun-001').lastSeen = now;
    await waitFor(() => app.game.s.phase === 'ACTIVE');
    assert.equal((await action('pause')).status, 200); assert.equal(app.game.batteryOverride(app.game.player('gun-001')), false);
    assert.equal((await action('start')).status, 200, '再開は既存の動作確認モードを引き継ぐ');
    assert.equal((await action('finish')).status, 200); assert.equal(app.game.s.winner, null);
    assert.equal((await action('demo_source', {source: 'simulation'})).status, 200);
    await waitFor(() => app.game.s.players.every(p => p.firmwareVersion === '0.8.0-sim'));
    assert.equal(app.game.s.testMode, false); assert.equal(app.game.s.phase, 'LOBBY');
    assert.deepEqual(requests, []);
  } finally {
    display?.terminate(); if (client) await client.endAsync(true); await app.close();
    await new Promise(resolve => tickets.close(resolve)); rmSync(dir, {recursive: true, force: true});
  }
});

test('以前の本番データに残る動作確認は再開せず待機へ戻し、通常試合の停止データは保持する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'arena-mode-recovery-'));
  const saved = new Game(devices).s;
  saved.phase = 'PAUSED'; saved.testMode = true; saved.participantIds = ['gun-001'];
  storage(dir).save(saved);
  const app = await createApp({config, dataDir: dir, bind: '127.0.0.1'});
  try {assert.equal(app.game.s.phase, 'LOBBY'); assert.equal(app.game.s.testMode, false); assert.deepEqual(app.game.s.participantIds, []);}
  finally {await app.close(); rmSync(dir, {recursive: true, force: true});}
  saved.testMode = false;
  const recovered = new Game(devices, {saved, allowTestMode: false});
  assert.equal(recovered.s.phase, 'PAUSED');
});
