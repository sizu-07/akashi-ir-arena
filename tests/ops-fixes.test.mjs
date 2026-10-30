import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TicketQueue} from '../apps/ticket-server/tickets.mjs';
import {createTicketApp} from '../apps/ticket-server/main.mjs';
import {Game} from '../apps/server/game.mjs';
import {hardware} from '../apps/server/hardware.mjs';

let requestNumber = 0;
const register = (queue, nickname, partySize) => queue.register({requestId: `ops-request-${++requestNumber}`, nickname, partySize, consent: true});

test('an empty slot left by a cancelled group is closed automatically', () => {
  let now = Date.parse('2026-09-17T17:07:00+09:00');
  const queue = new TicketQueue({now: () => now});
  register(queue, 'A', 4);
  const middle = register(queue, 'B', 4);
  register(queue, 'C', 4);
  const [first, second, third] = queue.operatorView().rounds;
  assert.deepEqual([first, second, third].map((round) => round.slotStartAt - first.slotStartAt), [0, 15 * 60_000, 30 * 60_000]);
  const middleId = queue.state.tickets.find((ticket) => ticket.ticketNumber === middle.ticketNumber).id;
  queue.operatorAction({action: 'cancel', ticketId: middleId, reason: '来場できない', operator: 'operator'});
  const rounds = queue.operatorView().rounds.filter((round) => round.ticketIds.length);
  // 後ろの組は空いた枠へ前詰めされ、間に空き枠が残らない。
  assert.deepEqual(rounds.map((round) => round.slotStartAt - first.slotStartAt), [0, 15 * 60_000]);
});

test('the first waiting slot moves forward to the earliest open slot', () => {
  let now = Date.parse('2026-09-17T17:07:00+09:00');
  const queue = new TicketQueue({now: () => now});
  register(queue, 'A', 4);
  const round = queue.state.rounds[0];
  // 何らかの理由で先頭の枠が後ろにずれていても、調整枠がなければ今入れる枠まで戻る。
  round.slotStartAt += 60 * 60_000;
  queue.scheduleRounds();
  assert.equal(queue.round(round.id).slotStartAt, Date.parse('2026-09-17T17:15:00+09:00'));
});

test('operators can return a manually timed slot to the automatic order', () => {
  let now = Date.parse('2026-09-17T17:07:00+09:00');
  const queue = new TicketQueue({now: () => now});
  register(queue, 'A', 4);
  const round = queue.state.rounds[0];
  queue.operatorAction({action: 'round_time', roundId: round.id, value: Date.parse('2026-09-17T18:00:00+09:00'), reason: 'テスト', operator: 'operator'});
  assert.equal(queue.round(round.id).slotStartAt, Date.parse('2026-09-17T18:00:00+09:00'));
  const result = queue.operatorAction({action: 'round_time_auto', roundId: round.id, reason: '', operator: 'operator'});
  assert.match(result.notice, /自動の時刻/);
  assert.equal(queue.round(round.id).slotStartAt, Date.parse('2026-09-17T17:15:00+09:00'));
  assert.equal(queue.round(round.id).status, 'SCHEDULED');
});

test('every logged-in device can operate and a 6-digit password is accepted', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-ticket-'));
  const app = await createTicketApp({dataDir: dir, operatorPassword: '123456', gameApiKey: 'ops-test-game-api-key-0123456789'});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const login = async () => {
      const response = await fetch(`${base}/api/operator/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password: '123456'})});
      assert.equal(response.status, 200);
      return {cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json()};
    };
    const tablet = await login(), phone = await login();
    for (const [index, session] of [tablet, phone].entries()) {
      const response = await fetch(`${base}/api/operator/action`, {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf}, body: JSON.stringify({action: 'global_message', value: `端末${index}`, commandId: `msg-${index}`})});
      assert.equal(response.status, 200);
    }
    assert.equal(app.queue.state.globalMessage, '端末1');
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
  await assert.rejects(createTicketApp({dataDir: dir, operatorPassword: '12345', gameApiKey: 'ops-test-game-api-key-0123456789'}), /6文字以上/);
});

test('a start blocked by a disconnected gun names it and suggests taking it out of service', () => {
  let now = 100000;
  const devices = [1, 2, 3, 4].map((n) => ({id: `gun-00${n}`, name: `P${n}`, shooterId: n}));
  const game = new Game(devices, {now: () => now});
  const telemetry = {syncRtt: 10, hardware_profile: hardware.profile, hardware_ready: true, firmware_version: '0.8.2-4e42', bench: false};
  for (const device of devices.slice(0, 3)) { game.hello(device.id, 'boot'); game.heartbeat(device.id, telemetry); }
  assert.throws(() => game.start(true), /P4（gun-004）の接続.*使用停止/);
  game.setOutOfService('gun-004', true);
  game.start(true);
  assert.equal(game.s.phase, 'COUNTDOWN');
});

test('during the pre-game video, "force finish" returns to waiting and a new match can be prepared', async () => {
  const {createApp} = await import('../apps/server/main.mjs');
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ops-game-'));
  const config = {httpPort: 0, mqttPort: 0, operatorPin: '24680135', devices: [1, 2, 3, 4].map((n) => ({id: `gun-00${n}`, key: `ops-key-${n}`, name: `P${n}`, shooterId: n}))};
  const app = await createApp({config, dataDir: dir, bind: '127.0.0.1'});
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    const response = await fetch(`${base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pin: config.operatorPin})});
    const session = {cookie: response.headers.get('set-cookie').split(';')[0], ...await response.json()};
    let id = 0;
    const act = (body) => fetch(`${base}/api/action`, {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.csrf}, body: JSON.stringify({commandId: `ops-${++id}`, ...body})});
    assert.equal((await act({action: 'media', mode: 'video'})).status, 200);
    assert.equal(app.game.s.media, 'video');
    // 銃が切れて開始できなくても、強制終了で動画・試し撃ちをやめて待機状態に戻れる。
    const failed = await act({action: 'start'});
    assert.equal(failed.status, 400);
    assert.equal((await act({action: 'finish'})).status, 200);
    assert.equal(app.game.s.phase, 'LOBBY');
    assert.equal(app.game.s.media, 'score');
    assert.equal((await act({action: 'media', mode: 'video'})).status, 200);
    assert.equal((await act({action: 'new'})).status, 200);
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
