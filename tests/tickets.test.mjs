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
  assert.equal(first.slotStartAt % (15 * 60_000), 0);
  assert.equal(second.slotStartAt - first.slotStartAt, 15 * 60_000);
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

test('現在時刻に依存せず切りのよい15分枠へ割り当て、前枠の開始時刻を入場予定にする', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  const first = queue.register({requestId: 'fixed-slot-first', nicknames: ['A1', 'A2', 'A3', 'A4'], partySize: 4, consent: true});
  const second = queue.register({requestId: 'fixed-slot-second', nicknames: ['B1', 'B2', 'B3', 'B4'], partySize: 4, consent: true});

  const rounds = queue.operatorView().rounds;
  assert.equal(new Date(rounds[0].slotStartAt).toISOString(), '2026-09-17T08:15:00.000Z');
  assert.equal(new Date(rounds[0].slotEndAt).toISOString(), '2026-09-17T08:30:00.000Z');
  assert.equal(new Date(rounds[1].slotStartAt).toISOString(), '2026-09-17T08:30:00.000Z');
  assert.equal(queue.publicTicket(first.accessToken).waitMinutes, 0);
  assert.equal(queue.publicTicket(second.accessToken).estimatedCallAt, rounds[0].slotStartAt);
  assert.equal(queue.publicTicket(second.accessToken).waitMinutes, 8);
});

test('遅延を15分枠単位で設定し、実施枠と来場者予定を後ろへ移動する', () => {
  const now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  const ticket = queue.register({requestId: 'delayed-slot-ticket', nicknames: ['遅延確認'], partySize: 1, consent: true});
  const nominalStart = queue.operatorView().rounds[0].slotStartAt;
  queue.operatorAction({
    action: 'settings',
    value: {globalDelaySlots: 2, graceMinutes: 3, maxWaitingGroups: 100},
    operator: 'operator',
  });
  const round = queue.operatorView().rounds[0];
  assert.equal(queue.state.settings.globalDelayMinutes, 30);
  assert.equal(round.effectiveSlotStartAt, nominalStart + 30 * 60_000);
  assert.equal(round.effectiveSlotEndAt - round.effectiveSlotStartAt, 15 * 60_000);
  assert.equal(queue.publicTicket(ticket.accessToken).slotStartAt, round.effectiveSlotStartAt);
  assert.equal(queue.publicTicket(ticket.accessToken).estimatedCallAt, round.effectiveSlotStartAt - 15 * 60_000);
});

test('呼出中の前へ遅延枠を挿入し、体験中の枠は動かさず次枠だけを後ろへ移動する', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  queue.register({requestId: 'delay-called-first', nicknames: ['A1', 'A2', 'A3', 'A4'], partySize: 4, consent: true});
  queue.register({requestId: 'delay-called-second', nicknames: ['B1', 'B2', 'B3', 'B4'], partySize: 4, consent: true});
  const [first, second] = queue.operatorView().rounds;
  const nominalFirstStart = first.slotStartAt;
  queue.callNext('operator');
  queue.operatorAction({action: 'settings', value: {globalDelaySlots: 1, graceMinutes: 3, maxWaitingGroups: 100}, operator: 'operator'});
  assert.equal(queue.operatorView().rounds.find((round) => round.id === first.id).effectiveSlotStartAt, nominalFirstStart + 15 * 60_000);

  for (const id of queue.round(first.id).ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'delayed-round-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  const playingStart = queue.operatorView().rounds.find((round) => round.id === first.id).effectiveSlotStartAt;
  assert.equal(queue.round(second.id).status, 'SCHEDULED');
  now = playingStart;
  assert.equal(queue.callDueRound('automatic-time')?.id, second.id);
  assert.equal(queue.round(second.id).status, 'CALLED');

  queue.operatorAction({action: 'settings', value: {globalDelaySlots: 2, graceMinutes: 3, maxWaitingGroups: 100}, operator: 'operator'});
  const rounds = queue.operatorView().rounds;
  assert.equal(rounds.find((round) => round.id === first.id).effectiveSlotStartAt, playingStart);
  assert.equal(rounds.find((round) => round.id === second.id).effectiveSlotStartAt, playingStart + 45 * 60_000);
});

test('調整枠は終了時刻ごとに自動消化し、案内済みの開始予定を保ったまま次へ進む', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  register(queue, '先に実施する組', 4);
  register(queue, '調整待ちの組', 4);
  const [first, round] = queue.operatorView().rounds;
  queue.callNext('operator');
  for (const id of first.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'adjustment-seed-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  queue.applyGameEvent({eventId: 'adjustment-seed-end', type: 'GAME_ENDED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  const nominalStart = round.slotStartAt;
  queue.operatorAction({action: 'settings', value: {globalDelaySlots: 2, graceMinutes: 3, maxWaitingGroups: 100}, operator: 'operator'});
  const announcedStart = queue.round(round.id).scheduledAt;

  now = nominalStart + 15 * 60_000 - 1;
  assert.equal(queue.advanceTime().changed, false);
  assert.equal(queue.state.settings.globalDelayMinutes, 30);
  now += 1;
  const firstAdvance = queue.advanceTime('automatic-time', {requireStarted: true});
  assert.equal(firstAdvance.elapsedAdjustmentSlots, 1);
  assert.equal(queue.state.settings.globalDelayMinutes, 15);
  assert.equal(queue.round(round.id).scheduledAt, announcedStart);
  assert.equal(queue.round(round.id).status, 'CALLED');

  now = nominalStart + 30 * 60_000;
  const secondAdvance = queue.advanceTime('automatic-time', {requireStarted: true});
  assert.equal(secondAdvance.elapsedAdjustmentSlots, 1);
  assert.equal(queue.state.settings.globalDelayMinutes, 0);
  assert.equal(queue.state.settings.delayAnchorAt, null);
  assert.equal(queue.round(round.id).slotStartAt, announcedStart);
  assert.equal(queue.round(round.id).scheduledAt, announcedStart);
  assert.match(queue.state.globalMessage, /運営調整は終了/);
});

test('ゲーム終了通知がなくても固定枠の終了時刻で自動完了し、次枠へ進む', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  register(queue, '自動終了する組', 4);
  register(queue, '次に進む組', 4);
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  for (const id of first.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'auto-expire-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});

  now = first.effectiveSlotEndAt - 1;
  assert.equal(queue.advanceTime().completedRound, null);
  assert.equal(queue.round(first.id).status, 'PLAYING');
  now += 1;
  const result = queue.advanceTime();
  assert.equal(result.completedRound?.id, first.id);
  assert.equal(queue.round(first.id).status, 'COMPLETED');
  assert.ok(queue.round(first.id).ticketIds.every((id) => queue.ticket(id).status === 'COMPLETED'));
  assert.equal(queue.round(second.id).status, 'CALLED');

  const lateEnd = queue.applyGameEvent({eventId: 'auto-expire-late-end', type: 'GAME_ENDED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  assert.equal(lateEnd.alreadyCompleted, true);
});

test('一時停止中の体験枠は終了予定時刻を過ぎても自動完了しない', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  register(queue, '一時停止する組', 4);
  const round = queue.operatorView().rounds[0];
  queue.callNext('operator');
  for (const id of round.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'paused-expire-start', type: 'GAME_STARTED', targetRoundId: round.id, occurredAt: now, source: 'game'});
  queue.applyGameEvent({eventId: 'paused-expire-pause', type: 'GAME_PAUSED', targetRoundId: round.id, occurredAt: now, source: 'game'});
  now = round.effectiveSlotEndAt + 15 * 60_000;
  assert.equal(queue.advanceTime().completedRound, null);
  assert.equal(queue.round(round.id).status, 'PLAYING');
});

test('ゲーム開始後も次枠の開始15分前まで待って自動呼出する', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  queue.register({requestId: 'first-four-players', nicknames: ['A1', 'A2', 'A3', 'A4'], partySize: 4, consent: true});
  queue.register({requestId: 'next-four-players', nicknames: ['B1', 'B2', 'B3', 'B4'], partySize: 4, consent: true});
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  assert.throws(() => queue.applyGameEvent({eventId: 'too-early-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'}), /未入場/);
  for (const id of queue.round(first.id).ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'automatic-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  assert.equal(queue.round(first.id).status, 'PLAYING');
  assert.equal(queue.round(second.id).status, 'SCHEDULED');
  const secondCallAt = queue.operatorView().rounds.find((round) => round.id === second.id).callAt;
  now = secondCallAt - 1;
  assert.equal(queue.callDueRound('automatic-time'), null);
  now = secondCallAt;
  queue.callDueRound('automatic-time');
  assert.equal(queue.round(second.id).status, 'CALLED');
  assert.ok(queue.round(second.id).ticketIds.every((id) => queue.ticket(id).status === 'CALLED'));
  const secondSlotBeforeEnd = queue.round(second.id).slotStartAt;
  queue.applyGameEvent({eventId: 'automatic-pause', type: 'GAME_PAUSED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  assert.equal(queue.round(first.id).status, 'PLAYING');
  assert.ok(queue.round(first.id).ticketIds.every((id) => queue.ticket(id).status === 'PLAYING'));
  queue.applyGameEvent({eventId: 'automatic-resume', type: 'GAME_RESUMED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  queue.applyGameEvent({eventId: 'automatic-end', type: 'GAME_ENDED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  assert.equal(queue.round(first.id).status, 'COMPLETED');
  assert.equal(queue.round(second.id).status, 'CALLED');
  assert.equal(queue.round(second.id).slotStartAt, secondSlotBeforeEnd);
  assert.ok(queue.round(second.id).ticketIds.every((id) => queue.ticket(id).status === 'CALLED'));
});

test('運営中に待機列が空になった後の新規登録を自動で呼び出す', () => {
  const queue = new TicketQueue();
  register(queue, '最初', 4);
  const firstRound = queue.operatorView().rounds[0];
  queue.callNext('operator');
  for (const id of firstRound.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'drained-start', type: 'GAME_STARTED', targetRoundId: firstRound.id, occurredAt: Date.now(), source: 'game'});
  queue.applyGameEvent({eventId: 'drained-end', type: 'GAME_ENDED', targetRoundId: firstRound.id, occurredAt: Date.now(), source: 'game'});
  assert.equal(queue.state.rounds.some((round) => ['CALLED', 'PLAYING', 'SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)), false);

  const lateTicket = register(queue, '待機列が空の後', 2);
  const calledRound = queue.state.rounds.find((round) => round.status === 'CALLED');
  assert.ok(calledRound);
  assert.equal(queue.ticket(calledRound.ticketIds[0]).ticketNumber, lateTicket.ticketNumber);
  assert.equal(lateTicket.status, 'CALLED');
});

test('遅延中に待機列へ戻った新規登録は開始15分前まで呼び出さず、割当時刻も動かさない', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  register(queue, '完了させる組', 4);
  const first = queue.operatorView().rounds[0];
  queue.callNext('operator');
  for (const id of first.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'delay-drained-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  queue.applyGameEvent({eventId: 'delay-drained-end', type: 'GAME_ENDED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  queue.operatorAction({action: 'settings', value: {globalDelaySlots: 1, graceMinutes: 3, maxWaitingGroups: 100}, operator: 'operator'});

  const late = register(queue, '遅延後の新規組', 2);
  const scheduled = queue.round(queue.state.tickets.find((ticket) => ticket.ticketNumber === late.ticketNumber).roundId);
  const originalSlot = scheduled.slotStartAt;
  const callAt = scheduled.scheduledAt - 15 * 60_000;
  assert.equal(late.status, 'ASSIGNED');
  assert.throws(() => queue.callNext('operator'), /から呼び出します/);
  now = callAt - 1;
  queue.scheduleRounds();
  assert.equal(scheduled.slotStartAt, originalSlot);
  assert.equal(queue.callDueRound('automatic-time'), null);
  now = callAt;
  assert.equal(queue.callDueRound('automatic-time')?.id, scheduled.id);
  assert.equal(queue.publicTicket(late.accessToken).status, 'CALLED');
});

test('呼出中枠の空席を後続の入れる組で4人まで自動補完する', () => {
  const queue = new TicketQueue();
  register(queue, '運営済みにする組', 4);
  const completedRound = queue.operatorView().rounds[0];
  queue.callNext('operator');
  for (const id of completedRound.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'fill-seed-start', type: 'GAME_STARTED', targetRoundId: completedRound.id, occurredAt: Date.now(), source: 'game'});
  queue.applyGameEvent({eventId: 'fill-seed-end', type: 'GAME_ENDED', targetRoundId: completedRound.id, occurredAt: Date.now(), source: 'game'});

  const two = register(queue, '2人組', 2);
  const four = register(queue, '4人組', 4);
  const firstOne = register(queue, '最初の1人', 1);
  const three = register(queue, '3人組', 3);
  const secondOne = register(queue, '次の1人', 1);

  const called = queue.state.rounds.find((round) => round.status === 'CALLED');
  const calledTickets = called.ticketIds.map((id) => queue.ticket(id));
  assert.deepEqual(calledTickets.map((ticket) => ticket.partySize), [2, 1, 1]);
  assert.deepEqual(calledTickets.map((ticket) => ticket.ticketNumber), [two.ticketNumber, firstOne.ticketNumber, secondOne.ticketNumber]);
  assert.equal(calledTickets.reduce((sum, ticket) => sum + ticket.partySize, 0), 4);
  assert.equal(queue.publicTicket(firstOne.accessToken).status, 'CALLED');
  assert.equal(queue.publicTicket(secondOne.accessToken).status, 'CALLED');
  assert.deepEqual(
    queue.operatorView().rounds.filter((round) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)).map((round) => round.tickets.map((ticket) => ticket.ticketNumber)),
    [[four.ticketNumber], [three.ticketNumber]],
  );
});

test('呼出中の枠を二重に作らず、既存の重複呼出も安全に修復する', () => {
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
  assert.equal(active[0].number, second.number);
  assert.ok(logs.some((event) => event.type === 'state_repaired'));
});

test('体験中の1枠と次の呼出中1枠を同時に保持できる', () => {
  let now = new Date('2026-09-17T17:07:00+09:00').getTime();
  const queue = new TicketQueue({now: () => now});
  register(queue, '体験組', 4); register(queue, '次の組', 4);
  const [first, second] = queue.operatorView().rounds;
  queue.callNext('operator');
  for (const id of first.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'parallel-start', type: 'GAME_STARTED', targetRoundId: first.id, occurredAt: now, source: 'game'});
  now = queue.operatorView().rounds.find((round) => round.id === second.id).callAt;
  queue.callDueRound('automatic-time');
  const recovered = new TicketQueue({saved: structuredClone(queue.state), now: () => now});
  assert.equal(recovered.round(first.id).status, 'PLAYING');
  assert.equal(recovered.round(second.id).status, 'CALLED');
  assert.equal(recovered.round(second.id).slotStartAt - recovered.round(first.id).slotStartAt, 15 * 60_000);
});

test('対象枠のないイベントと呼出中への終了イベントを拒否する', () => {
  const queue = new TicketQueue();
  register(queue, '対象枠', 4);
  const round = queue.operatorView().rounds[0];
  queue.callNext('operator');
  assert.throws(() => queue.applyGameEvent({eventId: 'no-target', type: 'GAME_ENDED', occurredAt: Date.now(), source: 'game'}), /対象枠ID/);
  assert.throws(() => queue.applyGameEvent({eventId: 'not-playing', type: 'GAME_ENDED', targetRoundId: round.id, occurredAt: Date.now(), source: 'game'}), /体験中/);
  assert.equal(queue.round(round.id).status, 'CALLED');
});

test('呼出中の登録グループだけをスキップし、空席を後続グループで補完する', () => {
  const queue = new TicketQueue();
  const firstGroup = register(queue, '第1組', 2);
  const secondGroup = register(queue, '第2組', 2);
  const replacementGroup = register(queue, '補完組', 2);
  const first = queue.operatorView().rounds[0];
  queue.callNext('operator');
  const firstGroupId = queue.state.tickets.find((ticket) => ticket.ticketNumber === firstGroup.ticketNumber).id;
  const skipResult = queue.operatorAction({action: 'skip_group', ticketId: firstGroupId, reason: '来場なし', operator: 'operator'});
  assert.match(skipResult.notice, /スキップ済み/);
  assert.equal(queue.round(first.id).status, 'CALLED');
  assert.equal(queue.ticket(firstGroupId).status, 'NO_SHOW');
  assert.equal(queue.publicTicket(firstGroup.accessToken).waitMinutes, null);
  assert.equal(queue.publicTicket(firstGroup.accessToken).estimatedCallAt, null);
  assert.equal(queue.publicTicket(firstGroup.accessToken).slotStartAt, null);
  assert.deepEqual(
    queue.round(first.id).ticketIds.map((id) => queue.ticket(id).ticketNumber),
    [secondGroup.ticketNumber, replacementGroup.ticketNumber],
  );
  assert.deepEqual(queue.operatorView().rounds.find((round) => round.id === first.id).skippedTickets.map((ticket) => ticket.ticketNumber), [firstGroup.ticketNumber]);
  assert.equal(queue.operatorView().rounds.find((round) => round.id === first.id).assignedPeople, 4);
  assert.equal(queue.operatorView().rounds.find((round) => round.id === first.id).skippedPeople, 2);

  const recallResult = queue.operatorAction({action: 'recall_group', ticketId: firstGroupId, reason: '来場を確認', operator: 'operator'});
  assert.match(recallResult.notice, /スキップを取り消し/);
  assert.equal(queue.ticket(firstGroupId).status, 'CALLED');
  assert.deepEqual(
    queue.round(first.id).ticketIds.map((id) => queue.ticket(id).ticketNumber),
    [secondGroup.ticketNumber, firstGroup.ticketNumber],
  );
  assert.equal(queue.state.tickets.find((ticket) => ticket.ticketNumber === replacementGroup.ticketNumber).status, 'ASSIGNED');
  assert.ok(queue.state.rounds.every((round) => !(round.skippedTicketIds ?? []).includes(firstGroupId)));
});

test('誤って終了した過去枠を再呼出ししてゲームを再実施できる', () => {
  const queue = new TicketQueue();
  register(queue, '再実施', 4);
  const round = queue.operatorView().rounds[0];
  queue.callNext('operator');
  for (const id of round.ticketIds) queue.checkIn(queue.ticket(id).qrToken, 'operator');
  queue.applyGameEvent({eventId: 'replay-start', type: 'GAME_STARTED', targetRoundId: round.id, occurredAt: Date.now(), source: 'game'});
  queue.applyGameEvent({eventId: 'replay-end', type: 'GAME_ENDED', targetRoundId: round.id, occurredAt: Date.now(), source: 'game'});

  queue.operatorAction({action: 'recall_past', roundId: round.id, reason: '終了操作の誤り', operator: 'operator'});
  assert.equal(queue.round(round.id).status, 'CALLED');
  assert.equal(queue.round(round.id).startedAt, null);
  assert.equal(queue.round(round.id).completedAt, null);
  assert.ok(queue.round(round.id).ticketIds.every((id) => queue.ticket(id).status === 'CALLED'));
});

test('入場済みの人がいる呼出中枠はスキップできない', () => {
  const queue = new TicketQueue();
  register(queue, '一部入場', 2); register(queue, '次枠', 4);
  const first = queue.operatorView().rounds[0];
  queue.callNext('operator');
  queue.checkIn(queue.ticket(first.ticketIds[0]).qrToken, 'operator');
  assert.throws(
    () => queue.operatorAction({action: 'skip_group', ticketId: first.ticketIds[0], reason: '誤操作', operator: 'operator'}),
    /未入場/,
  );
  assert.equal(queue.round(first.id).status, 'CALLED');
});

test('整理券操作は状態に応じて呼出中グループの保留・取消と空席補完を整合させる', () => {
  const queue = new TicketQueue();
  const first = register(queue, '保留対象', 2);
  const second = register(queue, '同じ枠', 2);
  const replacement = register(queue, '補完対象', 2);
  const round = queue.operatorView().rounds[0];
  queue.callNext('operator');
  const firstId = queue.state.tickets.find((ticket) => ticket.ticketNumber === first.ticketNumber).id;
  assert.throws(() => queue.operatorAction({action: 'hold', ticketId: firstId, reason: '', operator: 'operator'}), /理由/);
  queue.operatorAction({action: 'hold', ticketId: firstId, reason: 'あとで案内', operator: 'operator'});
  assert.equal(queue.ticket(firstId).status, 'ON_HOLD');
  assert.deepEqual(queue.round(round.id).ticketIds.map((id) => queue.ticket(id).ticketNumber), [second.ticketNumber, replacement.ticketNumber]);
  assert.ok(!queue.round(round.id).skippedTicketIds.includes(firstId));

  queue.operatorAction({action: 'release', ticketId: firstId, operator: 'operator'});
  assert.equal(queue.ticket(firstId).status, 'ASSIGNED');
  assert.ok(queue.state.rounds.every((item) => !(item.skippedTicketIds ?? []).includes(firstId)));

  const checkedId = queue.round(round.id).ticketIds[0];
  queue.checkIn(queue.ticket(checkedId).qrToken, 'operator');
  assert.throws(() => queue.operatorAction({action: 'cancel', ticketId: checkedId, reason: '誤取消', operator: 'operator'}), /入場処理を取り消して/);
});

test('保存済み状態の呼出中・スキップ表示の食い違いを起動時に修復する', () => {
  const original = new TicketQueue();
  register(original, 'スキップ対象', 2);
  register(original, '保留対象', 2);
  original.callNext('operator');
  const round = original.state.rounds[0];
  const [skippedId, heldId] = round.ticketIds;
  original.ticket(skippedId).status = 'NO_SHOW';
  original.ticket(heldId).status = 'ON_HOLD';
  round.skippedTicketIds = [heldId];

  const repaired = new TicketQueue({saved: structuredClone(original.state)});
  const repairedRound = repaired.round(round.id);
  assert.equal(repairedRound.status, 'SKIPPED');
  assert.deepEqual(repairedRound.ticketIds, []);
  assert.deepEqual(repairedRound.skippedTicketIds, [skippedId]);
  assert.equal(repaired.operatorView().rounds[0].skippedPeople, 2);
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
  const newTime = (Math.floor(Date.now() / (15 * 60_000)) + 3) * 15 * 60_000;
  queue.operatorAction({action: 'round_time', roundId: second.id, value: newTime, reason: '休憩時間調整', operator: 'operator'});
  assert.equal(queue.round(second.id).slotStartAt, newTime);
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
    const operatorPageBeforeLogin = await (await fetch(`${base}/operator`)).text();
    assert.match(operatorPageBeforeLogin, /id="calledGroups"/);
    assert.match(operatorPageBeforeLogin, /id="skippedGroups"/);
    assert.match(operatorPageBeforeLogin, /id="ticketDialogClose" type="button"/);
    assert.match(operatorPageBeforeLogin, /id="ticketDialogMessage"/);
    assert.doesNotMatch(operatorPageBeforeLogin, /id="recallCurrent"/);

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
    assert.ok(operatorPage.indexOf('operation-card') < operatorPage.indexOf('id="registrationBanner"'));
    assert.match(operatorPage, /id="takeover"[^>]*>操作権を取得<\/button><span id="compactRegistrationStatus"/);
    assert.ok(operatorPage.indexOf('queueTimeline') < operatorPage.indexOf('id="tickets"'));
    assert.ok(operatorPage.indexOf('id="tickets"') < operatorPage.indexOf('registrationStatus'));
    assert.ok(operatorPage.indexOf('registrationStatus') < operatorPage.indexOf('settingsForm'));
    assert.ok(operatorPage.indexOf('settingsForm') < operatorPage.indexOf('id="allRounds"'));
    assert.doesNotMatch(operatorPage, /name="cycleMinutes"/);
    assert.match(await (await fetch(`${base}/register`)).text(), /nicknameFields/);
    assert.doesNotMatch(await (await fetch(`${base}/ticket`)).text(), /id="round"/);
    const scannerPage = await (await fetch(`${base}/scanner`)).text();
    assert.match(scannerPage, /\/vendor\/jsqr\.js/);
    assert.match(scannerPage, /id="scanSuccess"/);
    const scannerScript = await (await fetch(`${base}/scanner.js`)).text();
    assert.match(scannerScript, /detectWithFallback/);
    assert.match(scannerScript, /showSuccess/);
    const jsQrResponse = await fetch(`${base}/vendor/jsqr.js`);
    assert.equal(jsQrResponse.status, 200);
    assert.match(await jsQrResponse.text(), /jsQR/);
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
    if (request.method === 'GET') {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({roundId: 'retry-round', playerNicknames: ['1', '2', '3', '4'], assignedPeople: 4, checkedInPeople: 4, ready: true}));
      return;
    }
    let text = '';
    for await (const chunk of request) text += chunk;
    received.push(JSON.parse(text));
    response.writeHead(received.length === 1 ? 500 : 200, {'Content-Type': 'application/json'});
    response.end(JSON.stringify({ok: received.length > 1}));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = createTicketBridge({url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', dataDir: dir});
  try {
    await bridge.loadPlayerNicknames();
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

test('対象枠が未確定のゲームイベントを送信せず、古い不正な再送データを除去する', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-bridge-target-test-'));
  const events = [];
  const logs = [];
  writeFileSync(path.join(dir, 'ticket-outbox.json'), JSON.stringify([{eventId: 'old-null-target', targetRoundId: null, type: 'GAME_ENDED'}]));
  const server = (await import('node:http')).createServer(async (request, response) => {
    if (request.method === 'POST' && request.url === '/api/game/events') events.push(request.url);
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const bridge = createTicketBridge({url: `http://127.0.0.1:${server.address().port}`, apiKey: 'test-key', dataDir: dir, log: (entry) => logs.push(entry)});
  try {
    bridge.observe({id: 'game-without-ticket', phase: 'LOBBY'});
    bridge.observe({id: 'game-without-ticket', phase: 'ACTIVE'});
    await new Promise((resolve) => setTimeout(resolve, 50));
    await bridge.close();
    assert.deepEqual(events, []);
    assert.deepEqual(JSON.parse(readFileSync(path.join(dir, 'ticket-outbox.json'), 'utf8')), []);
    assert.ok(logs.some((entry) => entry.type === 'ticket_outbox_invalid_events_removed'));
    assert.ok(logs.some((entry) => entry.type === 'ticket_event_not_queued'));
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
    const nextDuringPlay = await (await fetch(`${base}/api/game/current-round`, {headers: {Authorization: `Bearer ${apiKey}`}})).json();
    assert.equal(nextDuringPlay.status, 'PLAYING');
    assert.equal(nextDuringPlay.roundId, current.roundId);
    assert.equal((await event('e2e-end', 'GAME_ENDED', current.roundId)).status, 200);
    assert.equal((await (await fetch(`${base}/api/public/ticket/${first.accessToken}`)).json()).status, 'COMPLETED');
    const nextRound = app.queue.state.rounds.find((round) => round.number === 2);
    assert.equal(nextRound.status, 'SCHEDULED');
    assert.equal(nextRound.scheduledAt - 15 * 60_000, app.queue.operatorView().rounds.find((round) => round.id === nextRound.id).callAt);
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
    response.writeHead(201); response.end();
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

test('Supabase Secret KeyはJWT用Authorizationヘッダーへ設定しない', async () => {
  let receivedHeaders;
  const server = (await import('node:http')).createServer((request, response) => {
    receivedHeaders = request.headers;
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('[]');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const store = supabaseTicketStorage({url: `http://127.0.0.1:${server.address().port}`, secretKey: 'sb_secret_test'});
    assert.equal(await store.load(), null);
    assert.equal(receivedHeaders.apikey, 'sb_secret_test');
    assert.equal(receivedHeaders.authorization, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('整理券メンバー反映とゲーム開始を別操作として扱う', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'ticket-member-sync-test-'));
  let currentRoundReads = 0;
  const ticketServer = (await import('node:http')).createServer((request, response) => {
    if (request.url === '/api/game/current-round') {
      currentRoundReads += 1;
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end(JSON.stringify({roundId: 'called-round', playerNicknames: ['春', '夏', '秋', '冬'], assignedPeople: 4, checkedInPeople: 4, ready: true}));
      return;
    }
    response.writeHead(200, {'Content-Type': 'application/json'});
    response.end('{"ok":true}');
  });
  await new Promise((resolve) => ticketServer.listen(0, '127.0.0.1', resolve));
  const config = {
    httpPort: 0,
    mqttPort: 0,
    operatorPin: '12345678',
    ticketServerUrl: `http://127.0.0.1:${ticketServer.address().port}`,
    ticketServerApiKey: 'member-sync-test-key',
    devices: [1, 2, 3, 4].map((number) => ({id: `gun-00${number}`, key: `test-${number}`, name: `P${number}`, team: number < 3 ? 'A' : 'B', shooterId: number})),
  };
  const app = await createGameApp({config, dataDir: dir, bind: '127.0.0.1'});
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    const page = await (await fetch(base)).text();
    assert.match(page, /id="syncTicketMembers"[^>]*data-action="sync_ticket_members"/);
    const loginResponse = await fetch(`${base}/api/login`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({pin: config.operatorPin})});
    const login = await loginResponse.json();
    const headers = {'Content-Type': 'application/json', Cookie: loginResponse.headers.get('set-cookie').split(';')[0], 'X-CSRF-Token': login.csrf};
    const operate = (action, commandId, extra = {}) => fetch(`${base}/api/action`, {method: 'POST', headers, body: JSON.stringify({action, commandId, ...extra})});

    const prematureStart = await operate('start', 'start-before-member-sync');
    assert.equal(prematureStart.status, 400);
    assert.match((await prematureStart.json()).error, /整理券メンバーを反映/);
    assert.equal(currentRoundReads, 0);

    const syncResponse = await operate('sync_ticket_members', 'sync-members-once');
    const syncResult = await syncResponse.json();
    assert.equal(syncResponse.status, 200);
    assert.match(syncResult.notice, /春 \/ 夏 \/ 秋 \/ 冬/);
    assert.deepEqual(app.game.s.players.map((player) => player.name), ['春', '夏', '秋', '冬']);
    assert.equal(app.game.s.phase, 'LOBBY');
    assert.equal(currentRoundReads, 1);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).ticketBridge.membersLoaded, true);

    assert.equal((await operate('new', 'create-next-game', {rules: app.game.s.rules})).status, 200);
    assert.equal((await (await fetch(`${base}/api/state`)).json()).ticketBridge.membersLoaded, false);
    const newGameStart = await operate('start', 'start-new-game-before-sync');
    assert.match((await newGameStart.json()).error, /整理券メンバーを反映/);
    assert.equal((await operate('sync_ticket_members', 'sync-next-game')).status, 200);
    assert.equal(currentRoundReads, 2);

    const startResponse = await operate('start', 'start-without-display');
    assert.equal(startResponse.status, 400);
    assert.match((await startResponse.json()).error, /投影画面/);
    assert.equal(currentRoundReads, 2);
  } finally {
    await app.close();
    await new Promise((resolve) => ticketServer.close(resolve));
    rmSync(dir, {recursive: true, force: true});
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
    assert.match(gamePage, /href="\/tickets" data-ticket-destination="operator"[^>]*>整理券運営（公開）/);
    assert.match(gamePage, /href="\/tickets\/register" data-ticket-destination="register"[^>]*>来場者受付/);
    assert.match(gamePage, /href="\/tickets\/scanner" data-ticket-destination="scanner"[^>]*>入場QR読取/);
    const linkResponse = await fetch(`${base}/api/ticket-links`);
    assert.equal(linkResponse.status, 200);
    const links = await linkResponse.json();
    const operatorLink = new URL(links.operator);
    assert.equal(`${operatorLink.origin}${operatorLink.pathname}`, 'https://tickets.example.test/operator');
    assert.equal(operatorLink.searchParams.get('game'), `${base}/`);
    assert.equal(links.register, 'https://tickets.example.test/register');
    assert.equal(links.scanner, 'https://tickets.example.test/scanner');
    const redirect = await fetch(`${base}/tickets`, {redirect: 'manual'});
    assert.equal(redirect.status, 302);
    const target = new URL(redirect.headers.get('location'));
    assert.equal(`${target.origin}${target.pathname}`, 'https://tickets.example.test/operator');
    assert.equal(target.searchParams.get('game'), `${base}/`);
    const registerRedirect = await fetch(`${base}/tickets/register`, {redirect: 'manual'});
    assert.equal(registerRedirect.status, 302);
    assert.equal(registerRedirect.headers.get('location'), 'https://tickets.example.test/register');
    const scannerRedirect = await fetch(`${base}/tickets/scanner`, {redirect: 'manual'});
    assert.equal(scannerRedirect.status, 302);
    assert.equal(scannerRedirect.headers.get('location'), 'https://tickets.example.test/scanner');
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});

test('公開整理券サーバー未設定時に存在しないローカル画面へ転送しない', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'operator-ticket-link-test-'));
  const config = {
    httpPort: 0,
    mqttPort: 0,
    operatorPin: '12345678',
    devices: [1, 2, 3, 4].map((number) => ({id: `gun-00${number}`, key: `test-${number}`, name: `P${number}`, team: number < 3 ? 'A' : 'B', shooterId: number})),
  };
  const app = await createGameApp({config, dataDir: dir, bind: '127.0.0.1'});
  const base = `http://127.0.0.1:${app.httpServer.address().port}`;
  try {
    const response = await fetch(`${base}/tickets`, {redirect: 'manual'});
    assert.equal(response.status, 503);
    assert.match((await response.json()).error, /公開整理券サーバーが未設定/);
    const links = await fetch(`${base}/api/ticket-links`);
    assert.equal(links.status, 503);
  } finally {
    await app.close();
    rmSync(dir, {recursive: true, force: true});
  }
});
