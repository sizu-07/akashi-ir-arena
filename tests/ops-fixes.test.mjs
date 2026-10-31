import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TicketQueue, EVENT_WINDOWS, EVENT_SCHEDULE} from '../apps/ticket-server/tickets.mjs';
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

test('rounds waiting behind a late called round never show a slot that already started', () => {
  let now = Date.parse('2026-09-17T17:07:00+09:00');
  const queue = new TicketQueue({now: () => now});
  register(queue, 'A', 4);
  register(queue, 'B', 4);
  queue.callNext('operator');
  // 呼出中の組がまだ始まらないまま時間が過ぎた。
  now = Date.parse('2026-09-17T17:41:00+09:00');
  queue.scheduleRounds();
  const waiting = queue.state.rounds.find((round) => round.status === 'SCHEDULED');
  assert.equal(waiting.slotStartAt, Date.parse('2026-09-17T17:45:00+09:00'));
  assert.ok(queue.operatorView().rounds.find((round) => round.id === waiting.id).callAt >= now);
});

test('a called slot with every group skipped can be ended without playing', () => {
  let now = Date.parse('2026-09-17T17:07:00+09:00');
  const queue = new TicketQueue({now: () => now});
  const gone = register(queue, '来ない組', 4);
  register(queue, '次の組', 4);
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  assert.throws(() => queue.operatorAction({action: 'end_called_round', roundId: first.id, operator: 'operator'}), /スキップ/);
  const goneId = queue.state.tickets.find((ticket) => ticket.ticketNumber === gone.ticketNumber).id;
  queue.operatorAction({action: 'skip_group', ticketId: goneId, reason: '来場なし', operator: 'operator'});
  assert.equal(queue.round(first.id).status, 'CALLED');
  const result = queue.operatorAction({action: 'end_called_round', roundId: first.id, operator: 'operator'});
  assert.match(result.notice, /実施せずに終了/);
  assert.equal(queue.round(first.id).status, 'SKIPPED');
  // 次の枠は前に詰まり、入場時刻（開始10分前）になっていれば呼び出される。
  assert.equal(queue.round(second.id).status, 'CALLED');
});

test('slots starting at 15:00 or later cannot be registered, and late tickets get an apology', () => {
  let now = Date.parse('2026-10-31T13:50:00+09:00');
  const queue = new TicketQueue({now: () => now});
  for (const name of ['14:00', '14:15', '14:30', '14:45', '15:00', '15:15']) register(queue, name, 4);
  const eventDays = EVENT_WINDOWS.map(({date, period}) => ({date, period, receptionStart: '', slotStart: '', slotEnd: ''}));
  eventDays[3] = {date: '2026-10-31', period: 'public', receptionStart: '09:45', slotStart: '10:00', slotEnd: '17:00'};
  queue.state.settings.eventDays = eventDays;
  queue.scheduleRounds();
  const tickets = queue.state.tickets.map((ticket) => queue.publicTicket(ticket.accessToken));
  assert.equal(tickets[0].apology, '');
  assert.equal(tickets[0].slotStartAt, Date.parse('2026-10-31T14:00:00+09:00'));
  assert.equal(tickets[3].apology, '');
  assert.deepEqual(tickets.slice(4).map((ticket) => ticket.slotStartAt), [Date.parse('2026-10-31T15:00:00+09:00'), Date.parse('2026-10-31T15:15:00+09:00')]);
  assert.ok(tickets.slice(4).every((ticket) => /15:00以降の枠/.test(ticket.apology)));
  assert.ok(queue.state.tickets.every((ticket) => ticket.status !== 'CANCELED'));
  const availability = queue.publicAvailability(1);
  assert.equal(availability.registration.code, 'full');
  assert.match(availability.registration.message, /15:00以降の枠には登録できません/);
  assert.throws(() => register(queue, '15時以降', 1), /15:00以降の枠には登録できません/);
});

test('a registration that would push a booked group past 15:00 is refused', () => {
  const now = Date.parse('2026-10-31T12:20:00+09:00');
  const queue = new TicketQueue({now: () => now});
  queue.operatorAction({action: 'event_days', value: structuredClone(EVENT_SCHEDULE), operator: 'test'});
  const at = (time) => Date.parse(`2026-10-31T${time}:00+09:00`);
  const booked = [[2, '13:45'], [4], [2], [4], [2, '14:15'], [4], [3], [3, '14:15'], [4], [1, '13:15']];
  for (const [size, time] of booked) {
    queue.register({requestId: `push-${size}-${time}-${requestNumber++}`, nickname: 'g', partySize: size, consent: true, earliestCallAt: time ? at(time) : null});
  }
  const lastSlotStart = () => Math.max(...queue.operatorView().rounds.filter((round) => round.tickets.length).map((round) => round.slotStartAt));
  assert.ok(lastSlotStart() < at('15:00'));
  assert.throws(() => register(queue, 'push', 4), /15:00以降の枠には登録できません/);
  assert.ok(lastSlotStart() < at('15:00'));
  assert.equal(queue.publicAvailability(4).registration.code, 'full');
});
