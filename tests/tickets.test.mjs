import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {TicketQueue} from '../apps/ticket-server/tickets.mjs';
import {createTicketApp} from '../apps/ticket-server/main.mjs';
import {createTicketBridge} from '../apps/server/ticket-bridge.mjs';
import {supabaseTicketStorage} from '../apps/ticket-server/store.mjs';
import {createApp as createGameApp} from '../apps/server/main.mjs';
import {linkTicketConfig} from '../tools/link-ticket-config.mjs';

let requestNumber = 0;
const register = (queue, nickname, partySize) => queue.register({requestId: `test-request-${++requestNumber}`, nickname, partySize, consent: true});

test('4席へ後続組を充当し、飛ばされた組を次回で優先する', () => {
  const queue = new TicketQueue();
  for (const [name, size] of [['A', 3], ['B', 2], ['C', 1], ['D', 2]]) register(queue, name, size);
  const [first, second] = queue.operatorView().rounds;
  assert.deepEqual(first.tickets.map((ticket) => ticket.nickname), ['A', 'C']);
  assert.deepEqual(second.tickets.map((ticket) => ticket.nickname), ['B', 'D']);
  assert.equal(first.assignedPeople, 4);
  assert.equal(second.assignedPeople, 4);
  assert.equal(new Set(queue.state.tickets.map((ticket) => ticket.receptionNumber)).size, 4);
});

test('単純な先入れでは空席になる場合も4席になる組合せを選ぶ', () => {
  const queue = new TicketQueue();
  register(queue, '先頭1名', 1);
  register(queue, '次の1名', 1);
  register(queue, '後続3名', 3);
  const [first, second] = queue.operatorView().rounds;
  assert.equal(first.assignedPeople, 4);
  assert.deepEqual(first.tickets.map((ticket) => ticket.nickname), ['先頭1名', '後続3名']);
  assert.deepEqual(second.tickets.map((ticket) => ticket.nickname), ['次の1名']);
});

test('1枠15分で参加者ごとのニックネームを保存する', () => {
  let now = 1_800_000_000_000;
  const queue = new TicketQueue({now: () => now});
  const ticket = queue.register({requestId: 'named-party-request', nicknames: ['あかし', 'ひかり', 'せん'], partySize: 3, consent: true});
  assert.deepEqual(ticket.playerNicknames, ['あかし', 'ひかり', 'せん']);
  assert.equal(queue.state.settings.cycleMinutes, 15);
  assert.equal(queue.state.settings.autoCall, true);
  assert.equal(queue.operatorView().rounds[0].scheduledAt, now + 15 * 60_000);
  assert.throws(() => queue.register({requestId: 'missing-name-request', nicknames: ['1人だけ'], partySize: 2, consent: true}), /一致/);
});

test('ゲーム開始で先頭枠が進行し、終了すると次枠を自動呼出する', () => {
  const queue = new TicketQueue();
  queue.register({requestId: 'first-four-players', nicknames: ['A1', 'A2', 'A3', 'A4'], partySize: 4, consent: true});
  queue.register({requestId: 'next-four-players', nicknames: ['B1', 'B2', 'B3', 'B4'], partySize: 4, consent: true});
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  assert.throws(() => queue.applyGameEvent({eventId: 'too-early-start', type: 'GAME_STARTED', occurredAt: Date.now(), source: 'game'}), /未入場/);
  for (const id of queue.round(first.id).ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'automatic-start', type: 'GAME_STARTED', occurredAt: Date.now(), source: 'game'});
  assert.equal(queue.round(first.id).status, 'PLAYING');
  queue.applyGameEvent({eventId: 'automatic-pause', type: 'GAME_PAUSED', targetRoundId: first.id, occurredAt: Date.now(), source: 'game'});
  assert.equal(queue.round(first.id).status, 'PLAYING');
  assert.ok(queue.round(first.id).ticketIds.every((id) => queue.ticket(id).status === 'PLAYING'));
  queue.applyGameEvent({eventId: 'automatic-resume', type: 'GAME_RESUMED', targetRoundId: first.id, occurredAt: Date.now(), source: 'game'});
  queue.applyGameEvent({eventId: 'automatic-end', type: 'GAME_ENDED', targetRoundId: first.id, occurredAt: Date.now(), source: 'game'});
  assert.equal(queue.round(first.id).status, 'COMPLETED');
  assert.equal(queue.round(second.id).status, 'CALLED');
  assert.ok(queue.round(second.id).ticketIds.every((id) => queue.ticket(id).status === 'CALLED'));
});

test('進行中の枠を重ねて呼び出さず、既存の重複状態も安全に修復する', () => {
  const queue = new TicketQueue();
  register(queue, '先頭', 4); register(queue, '次', 4);
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  assert.throws(() => queue.callNext('operator'), /呼出中/);
  queue.round(second.id).status = 'CALLED';
  for (const id of queue.round(second.id).ticketIds) queue.ticket(id).status = 'CHECKED_IN';
  const logs = [];
  const recovered = new TicketQueue({saved: structuredClone(queue.state), log: (event) => logs.push(event)});
  const active = recovered.state.rounds.filter((round) => ['CALLED', 'PLAYING'].includes(round.status));
  assert.equal(active.length, 1);
  assert.ok(active[0].ticketIds.some((id) => recovered.ticket(id).status === 'CHECKED_IN'));
  assert.equal(active[0].number, 1);
  assert.ok(logs.some((event) => event.type === 'state_repaired'));
});

test('ローカル整理券設定をゲーム設定へ秘密値を表示せず自動接続する', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-config-link-test-'));
  const gameFile = path.join(dir, 'game.json');
  const ticketFile = path.join(dir, 'ticket.json');
  try {
    writeFileSync(gameFile, JSON.stringify({httpPort: 8080}));
    writeFileSync(ticketFile, JSON.stringify({port: 8787, gameApiKey: 'a'.repeat(32)}));
    const result = linkTicketConfig({gameFile, ticketFile});
    const linked = JSON.parse(readFileSync(gameFile, 'utf8'));
    assert.equal(result.linked, true);
    assert.equal(linked.ticketServerUrl, 'http://127.0.0.1:8787');
    assert.equal(linked.ticketServerApiKey, 'a'.repeat(32));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test('呼出済みの回を固定し、QR入場とゲームイベントを1回だけ処理する', () => {
  const queue = new TicketQueue();
  register(queue, 'A', 3); register(queue, 'B', 1); register(queue, 'C', 4);
  const called = queue.callNext('operator');
  register(queue, 'D', 1);
  assert.deepEqual(queue.round(called.id).ticketIds.map((id) => queue.ticket(id).nickname), ['A', 'B']);
  const ticket = queue.ticket(called.ticketIds[0]);
  assert.equal(queue.checkIn(ticket.qrToken, 'operator').code, 'OK');
  assert.equal(queue.checkIn(ticket.qrToken, 'operator').code, 'ALREADY_USED');
  for (const id of called.ticketIds.slice(1)) assert.equal(queue.checkIn(queue.ticket(id).qrToken, 'operator').code, 'OK');
  const event = {eventId: 'event-1', type: 'GAME_STARTED', targetRoundId: called.id, occurredAt: Date.now(), source: 'test'};
  assert.equal(queue.applyGameEvent(event).duplicate, false);
  assert.equal(queue.applyGameEvent(event).duplicate, true);
  assert.equal(queue.round(called.id).status, 'PLAYING');
});

test('キャンセル後に呼出前の予定回だけを再計算する', () => {
  const queue = new TicketQueue();
  const a = register(queue, 'A', 3); register(queue, 'B', 2); const c = register(queue, 'C', 1); register(queue, 'D', 2);
  queue.cancelByVisitor(c.accessToken);
  const rounds = queue.operatorView().rounds;
  assert.deepEqual(rounds[0].tickets.map((ticket) => ticket.nickname), ['A']);
  assert.deepEqual(rounds[1].tickets.map((ticket) => ticket.nickname), ['B', 'D']);
  assert.equal(queue.publicTicket(a.accessToken).status, 'ASSIGNED');
});

test('運営は理由付きで予定回と予定時刻を手動固定できる', () => {
  const queue = new TicketQueue();
  register(queue, 'A', 2); register(queue, 'B', 2); register(queue, 'C', 2);
  const [first, second] = queue.operatorView().rounds;
  const b = first.tickets.find((ticket) => ticket.nickname === 'B');
  queue.operatorAction({action: 'move_round', ticketId: b.id, roundId: second.id, reason: '同行者対応', operator: 'operator'});
  assert.equal(queue.ticket(b.id).roundId, second.id);
  assert.equal(queue.round(second.id).status, 'LOCKED_SCHEDULED');
  const newTime = Date.now() + 30 * 60_000;
  queue.operatorAction({action: 'round_time', roundId: second.id, value: newTime, reason: '休憩時間調整', operator: 'operator'});
  assert.equal(queue.round(second.id).scheduledAt, newTime);
  assert.throws(() => queue.operatorAction({action: 'round_time', roundId: second.id, value: newTime, reason: '', operator: 'operator'}), /理由/);
});

test('HTTP同時登録、運営認証、操作冪等性、閲覧分離', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-test-'));
  const password = 'operator-password-123';
  const apiKey = 'game-api-key-12345678901234567890';
  const app = await createTicketApp({dataDir: dir, operatorPassword: password, gameApiKey: apiKey});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const registrations = await Promise.all(Array.from({length: 20}, (_, index) => fetch(`${base}/api/public/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId: `http-request-${index}`, nickname: `組${index}`, partySize: index % 4 + 1, consent: true})})));
    assert.ok(registrations.every((response) => response.status === 201));
    assert.equal(new Set(app.queue.state.tickets.map((ticket) => ticket.receptionNumber)).size, 20);
    assert.equal((await fetch(`${base}/api/public/ticket/not-a-token`)).status, 404);

    const loginResponse = await fetch(`${base}/api/operator/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password})});
    assert.equal(loginResponse.status, 200);
    const login = await loginResponse.json();
    const cookie = loginResponse.headers.get('set-cookie').split(';')[0];
    const actionBody = {action: 'registration', value: false, commandId: 'same-command'};
    const action = () => fetch(`${base}/api/operator/action`, {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': login.csrf}, body: JSON.stringify(actionBody)});
    assert.equal((await action()).status, 200);
    assert.equal((await action()).status, 200);
    assert.equal(app.queue.state.registrationOpen, false);

    const callResponse = await fetch(`${base}/api/operator/action`, {method: 'POST', headers: {'Content-Type': 'application/json', Cookie: cookie, 'X-CSRF-Token': login.csrf}, body: JSON.stringify({action: 'call_next', commandId: 'call-next-for-game'})});
    assert.equal(callResponse.status, 200);
    const currentRoundResponse = await fetch(`${base}/api/game/current-round`, {headers: {Authorization: `Bearer ${apiKey}`}});
    assert.equal(currentRoundResponse.status, 200);
    assert.equal((await currentRoundResponse.json()).playerNicknames.length, 4);

    const gameEvent = {eventId: 'missing-round', type: 'GAME_STARTED', occurredAt: Date.now(), source: 'test'};
    assert.equal((await fetch(`${base}/api/game/events`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer wrong'}, body: JSON.stringify(gameEvent)})).status, 401);

    const operatorPage = await (await fetch(`${base}/operator`)).text();
    assert.ok(operatorPage.indexOf('queueTimeline') < operatorPage.indexOf('id="tickets"'));
    assert.ok(operatorPage.indexOf('id="tickets"') < operatorPage.indexOf('registrationStatus'));
    assert.ok(operatorPage.indexOf('registrationStatus') < operatorPage.indexOf('settingsForm'));
    assert.doesNotMatch(operatorPage, /name="cycleMinutes"/);
    assert.match(await (await fetch(`${base}/register`)).text(), /nicknameFields/);
    assert.doesNotMatch(await (await fetch(`${base}/ticket`)).text(), /id="round"/);
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('ゲームイベントは同じIDのまま外部サーバーへ再送する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-bridge-test-'));
  const received = [];
  const server = (await import('node:http')).createServer(async (request, response) => {
    if (request.url === '/api/game/heartbeat') { response.writeHead(200); response.end(); return; }
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push(JSON.parse(text));
    response.writeHead(received.length === 1 ? 500 : 200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({ok: received.length > 1}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = createTicketBridge({url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', dataDir: dir});
  try {
    bridge.observe({id: 'game-1', phase: 'LOBBY'});
    bridge.observe({id: 'game-1', phase: 'ACTIVE'});
    await new Promise((resolve) => setTimeout(resolve, 100));
    await bridge.close();
    assert.equal(received.length, 2);
    assert.equal(received[0].eventId, received[1].eventId);
    assert.equal(received[0].retryNumber, 1);
    assert.equal(received[1].retryNumber, 2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('整理券の参加者名と対象枠をゲーム側へ連携する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-player-name-test-'));
  const received = [];
  const server = (await import('node:http')).createServer(async (request, response) => {
    if (request.url === '/api/game/heartbeat') { response.writeHead(200); response.end(); return; }
    if (request.method === 'GET') {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({roundId: 'round-1', playerNicknames: ['春', '夏', '秋', '冬'], assignedPeople: 4, checkedInPeople: 4, ready: true}));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push(JSON.parse(text));
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = createTicketBridge({url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', dataDir: dir});
  try {
    assert.deepEqual(await bridge.loadPlayerNicknames(), ['春', '夏', '秋', '冬']);
    bridge.observe({id: 'game-1', phase: 'LOBBY'});
    bridge.observe({id: 'game-1', phase: 'ACTIVE'});
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(received[0].targetRoundId, 'round-1');
  } finally {
    await bridge.close();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dir, {recursive: true, force: true});
  }
});

test('登録から呼出・入場・ゲーム開始終了・次枠呼出までHTTPで完了する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-e2e-test-'));
  const password = 'e2e-operator-password';
  const apiKey = 'e2e-game-api-key-1234567890';
  const app = await createTicketApp({dataDir: dir, operatorPassword: password, gameApiKey: apiKey});
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const registerGroup = async (requestId, names) => (await (await fetch(`${base}/api/public/register`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId, nicknames: names, partySize: names.length, consent: true})})).json());
    const first = await registerGroup('e2e-first-group', ['春', '夏', '秋', '冬']);
    await registerGroup('e2e-next-group', ['東', '西', '南', '北']);
    const loginResponse = await fetch(`${base}/api/operator/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password})});
    const login = await loginResponse.json();
    const operatorHeaders = {'Content-Type': 'application/json', Cookie: loginResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.csrf};
    const operatorAction = (action, commandId) => fetch(`${base}/api/operator/action`, {method: 'POST', headers: operatorHeaders, body: JSON.stringify({action, commandId})});
    assert.equal((await operatorAction('call_next', 'e2e-call')).status, 200);
    const checkIn = await fetch(`${base}/api/operator/check-in`, {method: 'POST', headers: operatorHeaders, body: JSON.stringify({value: `AKASHI:${first.qrToken}`})});
    assert.equal((await checkIn.json()).code, 'OK');
    assert.equal((await (await fetch(`${base}/api/public/ticket/${first.accessToken}`)).json()).status, 'CHECKED_IN');
    const current = await (await fetch(`${base}/api/game/current-round`, {headers: {Authorization: `Bearer ${apiKey}`}})).json();
    assert.deepEqual(current.playerNicknames, ['春', '夏', '秋', '冬']);
    const event = (eventId, type, targetRoundId) => fetch(`${base}/api/game/events`, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`}, body: JSON.stringify({eventId, type, targetRoundId, occurredAt: Date.now(), source: 'e2e-game'})});
    assert.equal((await event('e2e-start', 'GAME_STARTED', current.roundId)).status, 200);
    assert.equal((await (await fetch(`${base}/api/public/ticket/${first.accessToken}`)).json()).status, 'PLAYING');
    assert.equal((await event('e2e-end', 'GAME_ENDED', current.roundId)).status, 200);
    assert.equal((await (await fetch(`${base}/api/public/ticket/${first.accessToken}`)).json()).status, 'COMPLETED');
    assert.equal(app.queue.state.rounds.find((round) => round.status === 'CALLED')?.number, 2);
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('Supabase保存は状態と監査ログを応答前に確定できる', async () => {
  const requests = [];
  const server = (await import('node:http')).createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += chunk;
    requests.push({method: request.method, url: request.url, body: text && JSON.parse(text)});
    if (request.method === 'GET' && request.url.startsWith('/rest/v1/ticket_state')) {
      response.writeHead(200, {'Content-Type': 'application/json'}); response.end('[]'); return;
    }
    if (request.method === 'GET' && request.url.startsWith('/rest/v1/ticket_events')) {
      response.writeHead(200, {'Content-Type': 'application/json'}); response.end(JSON.stringify([{payload: {at: 1, type: 'test', operator: 'operator', details: {ok: true}}}])); return;
    }
    response.writeHead(204); response.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const store = supabaseTicketStorage({url: `http://127.0.0.1:${server.address().port}`, serviceRoleKey: 'service-role-test'});
    assert.equal(await store.load(), null);
    store.log({id: '00000000-0000-4000-8000-000000000001', at: 1, type: 'test'});
    store.save({tickets: [{id: 'one'}]});
    await store.flush();
    assert.equal(requests.filter((item) => item.method === 'POST').length, 2);
    assert.match(await store.csv(), /test/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('ゲーム運営と整理券運営を上部タブで相互に移動できる', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'operator-tabs-test-'));
  const config = {
    httpPort: 0,
    mqttPort: 0,
    operatorPin: '12345678',
    ticketServerUrl: 'https://tickets.example.test',
    devices: [1, 2, 3, 4].map((number) => ({id: `gun-00${number}`, key: `test-${number}`, name: `P${number}`, team: number < 3 ? 'A' : 'B', shooterId: number})),
  };
  const app = await createGameApp({config, dataDir: dir, bind: '127.0.0.1'});
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    const gamePage = await (await fetch(base)).text();
    assert.match(gamePage, /ゲーム運営/);
    assert.match(gamePage, /href="\/tickets">整理券運営/);
    const redirect = await fetch(`${base}/tickets`, {redirect: 'manual'});
    assert.equal(redirect.status, 302);
    const target = new URL(redirect.headers.get('location'));
    assert.equal(`${target.origin}${target.pathname}`, 'https://tickets.example.test/operator');
    assert.equal(target.searchParams.get('game'), `${base}/`);
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
