import test from 'node:test';
import assert from 'node:assert/strict';
import {operationStatus, pauseExplanation} from '../apps/web/operation-status.js';

const players = [1, 2, 3, 4].map(number => ({
  id:`gun-${number}`, name:`P${number}`, connected:true, lastSeen:1000, syncRtt:20,
  firmwareVersion:'0.8.0-4e42', hardwareReady:true, bench:false, lowBattery:false,
}));
const state = (overrides = {}) => ({
  phase:'LOBBY', round:1, serverMs:1000, players,
  participantIds:players.map(player => player.id),
  displayReady:true, ticketBridge:{enabled:true, membersLoaded:true},
  demo:false, simulation:false, testMode:false, ...overrides,
});
const options = {connected:true, isOwner:true, testRequested:false};

test('operator sees a clear ready state and individual missing preparation', () => {
  assert.match(operationStatus(state(), options).title, /開始できます/);
  const withoutDisplay = operationStatus(state({displayReady:false}), options);
  assert.match(withoutDisplay.title, /投影画面/);
  assert.match(withoutDisplay.next, /表示を準備/);
  const withoutNames = operationStatus(state({ticketBridge:{enabled:true, membersLoaded:false}}), options);
  assert.match(withoutNames.title, /参加者名/);
  const withoutDevice = operationStatus(state({players:[...players.slice(0, 3), {...players[3], connected:false}]}), options);
  assert.match(withoutDevice.title, /参加端末/);
  assert.match(withoutDevice.detail, /P4/);
});

test('operator sees why play stopped and what to do next', () => {
  const paused = operationStatus(state({phase:'PAUSED', pauseReason:'端末通信断'}), options);
  assert.equal(paused.tone, 'danger');
  assert.match(paused.title, /通信が切れました/);
  assert.match(paused.next, /再開/);
  const blocked = operationStatus(state({phase:'INTERMISSION', intermissionBlockedReason:'参加端末の接続・時刻同期を確認してください'}), options);
  assert.match(blocked.title, /自動開始できません/);
  assert.match(blocked.detail, /時刻同期/);
  assert.match(pauseExplanation('server_restart')[0], /サーバーが再起動/);
  const diagnostic = operationStatus(state({phase:'INTERMISSION', diagnostics:{enabled:true, intermissionHeld:true}}), options);
  assert.match(diagnostic.title, /一時診断中/);
  assert.match(diagnostic.detail, /自動進行を保留/);
});

test('disconnected and read-only screens explain why operation is unavailable', () => {
  assert.match(operationStatus(state(), {...options, connected:false}).next, /ネットワーク/);
  assert.match(operationStatus(state(), {...options, isOwner:false}).next, /操作権を取得/);
});
