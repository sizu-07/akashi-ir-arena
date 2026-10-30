import {batteryStatus} from './battery-status.js';
import {operationStatus} from './operation-status.js';
const $ = (id) => document.getElementById(id);

let csrf = '';
let sessionId = '';
let state = null;
let connected = false;
let ws;
let first = true;
let pending = false;
let previousDemoSource;
let playerPointerDown = false;
const testRequested = () => state?.demo && ($('testMode')?.checked ?? false);

function errorNext(text) {
  if (/rules(?:-intro)?\.webm/.test(text)) return 'メインPCの assets フォルダーに説明動画を置いてから、もう一度操作してください。';
  if (/投影画面|表示を準備/.test(text)) return '右上の「投影画面を開く」を押し、投影画面で「表示を準備」を押してください。';
  if (/整理券|メンバー/.test(text)) return '「整理券メンバーを反映」を押し、参加者名を確認してください。';
  if (/端末|4台|ファームウェア|電池|時刻同期/.test(text)) return '下の参加者・端末欄で該当端末を確認し、接続や設定を直してください。';
  if (/接続|通信/.test(text)) return 'メインPCのゲームサーバーとネットワークの接続を確認してください。';
  if (/操作権/.test(text)) return 'この画面の「操作権を取得」を押してください。';
  return '現在の状況と確認項目を見て原因を直し、もう一度操作してください。';
}

const message = (text, {error = false} = {}) => {
  if ($('dashboard').hidden) {
    $('message').textContent = text;
    $('message').className = error ? 'error' : '';
    return;
  }
  $('message').textContent = '';
  const alert = $('operationAlert');
  alert.hidden = !text;
  alert.dataset.tone = error ? 'danger' : 'success';
  alert.setAttribute('role', error ? 'alert' : 'status');
  $('operationAlertTitle').textContent = error ? '操作できませんでした' : '操作を反映しました';
  $('operationAlertText').textContent = text;
  $('operationAlertNext').textContent = error ? errorNext(text) : '';
  if (error && text) {
    $('operationCenter').scrollIntoView({block:'start', behavior:'smooth'});
    alert.focus({preventScroll:true});
  }
};

async function configureTicketLinks() {
  const response = await fetch('/api/ticket-links');
  if (!response.ok) return;
  const links = await response.json();
  document.querySelectorAll('[data-ticket-destination]').forEach((link) => {
    const destination = links[link.dataset.ticketDestination];
    if (destination) link.href = destination;
  });
}

async function post(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrf,
    },
    body: JSON.stringify(body),
  });
  const result = await response.json();

  if (!response.ok) {
    throw Error(result.error ?? '操作に失敗しました');
  }

  return result;
}

function commandId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function action(actionName, extra = {}) {
  if (!connected) {
    throw Error('接続が切れています');
  }

  const result = await post('/api/action', {
    action: actionName,
    commandId: commandId(),
    ...extra,
  });
  const notices = {start: '開始操作を受け付けました。', pause: 'ゲームを一時停止しました。', finish: '試合全体を終了しました。', demo_end_round: '現在のゲームを終了しました。', new: '新しい3ゲーム戦を準備しました。', sync_ticket_members: '整理券メンバーを反映しました。名前を確認してください。', media: '投影画面を切り替えました。', diagnostic_on:'一時診断を開始しました。', diagnostic_off:'一時診断を終了しました。', demo_hit: '発射・命中を送信しました。', motor_demo_hit: '被弾振動を送信しました。', motor_demo_defeat: '撃破振動を送信しました。', motor_demo_revive: '復活振動を送信しました。'};
  const videoNotices = {play: '動画を開始しました。', pause: '動画を停止しました。', restart: '動画を最初から再生しました。'};
  message(result.notice || (actionName === 'video' ? videoNotices[extra.operation] : notices[actionName]) || '操作を反映しました。');
}

function guarded(callback) {
  return async (event) => {
    event?.preventDefault();
    if (pending) return;
    pending = true;
    disable();

    try {
      await callback(event);
    } catch (error) {
      message(error.message, {error: true});
    } finally {
      pending = false;
      disable();
    }
  };
}

$('loginForm').onsubmit = guarded(async () => {
  const session = await post('/api/login', {pin: $('pin').value});
  $('pin').value = '';
  csrf = session.csrf;
  sessionId = session.id;
  await enter();
});

async function enter() {
  const response = await fetch('/api/session');

  if (!response.ok) {
    return;
  }

  const session = await response.json();
  csrf = session.csrf;
  sessionId = session.id;
  $('login').hidden = true;
  $('dashboard').hidden = false;
  $('provisionPanel').hidden = !session.local;
  if (!session.demo) $('demoControls')?.remove();
  connect();
}

function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);

  ws.onopen = () => {
    connected = true;
    renderOperation();
  };

  ws.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };

  ws.onclose = () => {
    connected = false;
    $('connection').textContent = '通信切断・操作不可';
    $('connection').className = 'badge offline';
    renderOperation();
    disable();
    setTimeout(connect, 1500);
  };
}

function disable() {
  const locked = pending || !connected;

  document
    .querySelectorAll('#dashboard button:not(#takeover):not(#dismissAlert)')
    .forEach((button) => {
      button.disabled = locked;
    });

  $('takeover').disabled = pending || !connected;
  $('syncTicketMembers').disabled = locked || !state?.ticketBridge?.enabled || state?.phase !== 'LOBBY';
  $('newMatch').disabled = locked || !(['LOBBY', 'FINISHED'].includes(state?.phase) || state?.demo && state?.testMode && state?.phase === 'INTERMISSION');
  if ($('testMode')) $('testMode').disabled = locked || state?.phase !== 'LOBBY' || !state?.simulation;
  if ($('demoSource')) $('demoSource').disabled = locked || !['LOBBY', 'FINISHED'].includes(state?.phase) && !(state?.phase === 'INTERMISSION' && state?.testMode);
  document.querySelector('[data-action=start]').disabled = locked || !['LOBBY', 'PAUSED', 'INTERMISSION'].includes(state?.phase) || (state?.phase === 'INTERMISSION' && !state.demo);
  document.querySelector('[data-action=pause]').disabled = locked || !['COUNTDOWN', 'ACTIVE'].includes(state?.phase);
  // 開始前でも説明動画・試し撃ち中なら「強制終了」で待機状態へ戻せる。
  document.querySelector('[data-action=finish]').disabled = locked || !(['COUNTDOWN', 'ACTIVE', 'PAUSED', 'INTERMISSION'].includes(state?.phase) || state?.phase === 'LOBBY' && (state?.diagnostics?.enabled || state?.media !== 'score'));
  $('demoEndRound').disabled = locked || state?.diagnostics?.enabled || !state?.demo || !['ACTIVE', 'PAUSED'].includes(state?.phase);
  $('diagnosticToggle').disabled = locked || state?.simulation || (!state?.diagnostics?.enabled && !state?.players?.some(player => player.connected && player.diagnosticCapable));
  const motorTarget = state?.players?.find((player) => player.id === $('motorDemoTarget').value);
  for (const button of ['motorDemoHit', 'motorDemoDefeat', 'motorDemoRevive'])
    $(button).disabled = locked || !state?.demo || state?.simulation || !motorTarget?.connected || !motorTarget.firmwareVersion?.startsWith('legacy-motor-demo-') || !Number.isInteger(motorTarget.demoDefeats) || !Number.isInteger(motorTarget.demoRevives);
  const mediaLocked = locked || ['ACTIVE', 'COUNTDOWN'].includes(state?.phase);
  document.querySelectorAll('[data-media], [data-video]').forEach((button) => {
    button.disabled = mediaLocked || (button.dataset.video === 'pause' && state?.media !== 'video');
  });
}

const names = {
  LOBBY: '待機',
  COUNTDOWN: '開始カウントダウン',
  ACTIVE: '試合中',
  PAUSED: '一時停止',
  INTERMISSION: '途中経過',
  FINISHED: '試合終了',
};

function renderOperation() {
  const status = operationStatus(state, {connected, isOwner:true, testRequested:testRequested()});
  $('operationCenter').dataset.tone = status.tone;
  $('operationTitle').textContent = status.title;
  $('operationState').textContent = !connected ? '通信切断' : state?.diagnostics?.enabled ? '診断中' : status.tone === 'danger' ? '要対応' : state?.phase === 'LOBBY' ? state?.simulation ? 'デモ待機' : status.tone === 'ready' ? '準備完了' : '準備中' : names[state?.phase] ?? '確認中';
  $('operationDetail').textContent = status.detail;
  $('operationNext').textContent = status.next;
  $('operationChecks').hidden = status.checks.length === 0;
  $('operationChecks').replaceChildren(...status.checks.map(check => {
    const item = document.createElement('div');
    item.className = `operation-check ${check.ok ? 'ok' : 'missing'}`;
    const label = document.createElement('strong');
    label.textContent = `${check.ok ? '✓' : '!'} ${check.label}`;
    const detail = document.createElement('span');
    detail.textContent = check.detail;
    item.append(label, detail);
    return item;
  }));
}

function textElement(tag, className, content) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = content;
  return element;
}

const ledNames = {OFF:'消灯', RED:'赤', BLUE:'青', GREEN:'緑', CYAN:'水色', ORANGE:'オレンジ', PURPLE:'紫', WHITE:'白', YELLOW:'黄', MIXED:'混合'};
const receiverNames = {rx1:'前', rx2:'左', rx3:'右'};
const timeLabel = (at) => new Date(at).toLocaleTimeString('ja-JP', {hour:'2-digit', minute:'2-digit', second:'2-digit'});

function activityFor(player) {
  const gameEvents = (state.activity ?? []).flatMap(event => {
    if (event.type === 'shot' && event.deviceId === player.id) return [{at:event.at, text:'試合で射撃'}];
    if (event.type === 'hit' && event.deviceId === player.id) return [{at:event.at, text:`${state.players.find(p => p.id === event.shooter)?.name ?? '相手'}から被弾`}];
    if (event.type === 'hit' && event.shooter === player.id) return [{at:event.at, text:`${state.players.find(p => p.id === event.deviceId)?.name ?? '相手'}に命中`}];
    if (event.type === 'respawn' && event.deviceId === player.id) return [{at:event.at, text:'復活'}];
    return [];
  });
  const diagnosticEvents = (state.diagnostics?.events ?? []).flatMap(event => {
    if (event.type === 'shot' && event.playerId === player.id) return [{at:event.at, text:'診断射撃（戦績対象外）'}];
    if (event.type === 'hit' && event.playerId === player.id) return [{at:event.at, text:`${event.shooterName}の診断信号を${receiverNames[event.receiverId]}で受信`}];
    if (event.type === 'hit' && event.shooterId === player.id) return [{at:event.at, text:`${event.playerName}が診断信号を受信`}];
    if (event.type === 'respawn' && event.playerId === player.id) return [{at:event.at, text:'診断で自動復活'}];
    return [];
  });
  return [...gameEvents, ...diagnosticEvents].sort((a,b) => b.at-a.at).slice(0, 3);
}

function indicator(label, value, tone='neutral') {
  const item = document.createElement('div');
  item.className = `device-indicator ${tone}`;
  item.append(textElement('span', 'indicator-label', label), textElement('strong', 'indicator-value', value));
  return item;
}

function render() {
  $('connection').textContent = state.demo ? state.simulation ? 'デモ：仮想端末で確認' : 'デモ：接続した実機で確認' : '本番：実機サーバー接続済';
  $('connection').className = 'badge';
  $('phase').textContent = state.testMode && state.phase === 'ACTIVE' ? '動作確認中' : state.testMode && state.phase === 'FINISHED' ? '動作確認終了' : names[state.phase];
  $('clockLabel').textContent = state.diagnostics?.intermissionHeld ? '次ゲームまで（一時保留）' : state.phase === 'INTERMISSION' && !state.demo ? '次ゲームまで' : '残り時間';
  $('clock').textContent = state.diagnostics?.intermissionHeld ? '保留中' : state.phase === 'INTERMISSION' && !state.demo && state.intermissionEndsAt
    ? time(Math.max(0, state.intermissionEndsAt - state.serverMs)) : time(Math.ceil(state.remainingMs * (state.rules.displayDurationSec ?? state.rules.durationSec) / state.rules.durationSec));
  $('roundLabel').textContent = `第${state.round}ゲーム / 全${state.rules.rounds}ゲーム`;
  $('score').textContent = [...state.players].sort((a,b)=>b.kills-a.kills).map(p=>`${p.name} ${p.kills}`).join(' / ');
  // ログインしている端末はすべて操作できる。
  $('role').textContent = 'ログイン中・この端末で操作できます';

  const connectedPlayers = state.players.filter((player) => player.connected).length;
  if ($('demoControls')) $('demoControls').hidden = !state.demo;
  $('demoEndRound').hidden = !state.demo;
  $('roundFlow').textContent = state.demo
    ? 'デモではこのゲームを途中で終了して次の途中経過を確認できます。次ゲームの開始と試合全体の終了も手動です。'
    : '各ゲームの実時間は85秒、投影時計は90秒表示。途中経過を15秒表示し、次ゲームのカウントダウンへ自動で進みます。';
  if ($('demoSource')) $('demoSource').value = state.demoSource;
  if ($('testMode')) {
    if (previousDemoSource !== state.demoSource) $('testMode').checked = !state.simulation;
    if (state.phase !== 'LOBBY') $('testMode').checked = state.testMode;
    else if (!state.simulation) $('testMode').checked = true;
  }
  previousDemoSource = state.demoSource;
  $('readiness').textContent =
    `投影: ${state.displayReady ? '準備完了' : '準備が必要'} ／ ` +
    `${state.simulation ? '仮想端末' : '実機接続'}: ${connectedPlayers}/4 ／ ` +
    `整理券: ${!state.ticketBridge?.enabled ? '未設定' : state.ticketBridge.connected ? '同期済み' : `未同期（再送待ち${state.ticketBridge.pending}件）`} ／ ` +
    `メンバー: ${!state.ticketBridge?.enabled ? '手動名' : state.ticketBridge.membersLoaded ? '反映済み' : state.ticketBridge.membersProvisional ? '仮名表示中・入場待ち' : '未反映'}`;
  $('syncTicketMembers').textContent = state.ticketBridge?.membersLoaded ? '整理券メンバーを更新' : state.ticketBridge?.membersProvisional ? '整理券メンバーを再確認' : '整理券メンバーを反映';
  document.querySelector('[data-action=start]').textContent = state.phase === 'PAUSED' ? 'ゲームを再開' : state.phase === 'INTERMISSION' ? state.demo ? `第${state.round}ゲームを開始` : '次ゲームは自動開始' : state.phase === 'COUNTDOWN' ? '開始カウントダウン中' : testRequested() ? '動作確認を開始' : '第1ゲームを開始';
  const hints = {
    LOBBY: state.ticketBridge?.membersProvisional ? '未入場の席は仮名です。入場確認が4人そろうと正式な名前に自動更新されます。' : state.ticketBridge?.enabled && !state.ticketBridge.membersLoaded ? '整理券メンバーを反映し、参加者の名前を確認してください。' : '参加者・端末を確認し、準備が整ったら「試合を開始」を押してください。',
    COUNTDOWN: '開始カウントダウン中です。異常があれば「一時停止」を押してください。',
    ACTIVE: '試合中です。異常時は「一時停止」、打ち切る場合は「試合全体を強制終了」を押してください。',
    PAUSED: '一時停止中です。端末と参加者を確認して「試合を再開」を押してください。',
    INTERMISSION: state.demo ? `第${state.round-1}ゲームの途中経過を確認し、第${state.round}ゲームを開始してください。` : state.intermissionBlockedReason ? `第${state.round}ゲームの自動開始待ち: ${state.intermissionBlockedReason}` : `途中経過を15秒表示後、第${state.round}ゲームのカウントダウンを自動開始します。`,
    FINISHED: '合計キル数で結果を表示しています。次の3ゲーム戦を準備できます。',
  };
  $('nextStep').textContent = hints[state.phase];
  if (['LOBBY', 'PAUSED'].includes(state.phase)) {
    if (!state.displayReady) $('nextStep').textContent = '「投影画面を開く」から「表示を準備」を押してください。';
    else if (testRequested() || state.testMode) $('nextStep').textContent = `接続中の${connectedPlayers}台で動作確認します。未接続の端末は参加しません。`;
    else if (connectedPlayers < 4) $('nextStep').textContent = `端末が${connectedPlayers}/4台接続されています。通常試合には4台必要です。`;
  }
  if (state.simulation && state.phase === 'LOBBY') $('nextStep').textContent = 'デモモードです。表示中の4台は仮想端末です。実機を確認する場合は、確認対象を「接続した実機」に切り替えてください。';
  renderOperation();
  document.querySelectorAll('[data-media]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.media === state.media)));

  const deviceElements = [];
  const playerElements = state.players.map((player) => {
    const batteryInfo = batteryStatus(player);
    const element = document.createElement('article');
    const online = player.connected && state.serverMs - player.lastSeen <= 3000;
    const respawnMs = state.phase === 'PAUSED' ? player.respawnRemainingMs : player.respawnAt - state.serverMs;
    const respawnSeconds = player.hp === 0 ? Math.max(0, Math.ceil(respawnMs / 1000)) : 0;
    const triggerRecent = Number.isFinite(player.lastTriggerAt) && state.serverMs - player.lastTriggerAt < 2300;
    const motorRecent = Number.isFinite(player.lastMotorAt) && state.serverMs - player.lastMotorAt < 2300;
    element.className = `player player-card ${player.outOfService ? 'is-out-of-service' : !online ? 'is-offline' : player.hp === 0 ? 'is-defeated' : 'is-connected'}${online && (player.triggerDown || triggerRecent) ? ' is-triggered' : ''}`;

    const title = document.createElement('h3');
    title.textContent = player.name;
    const identity = document.createElement('div');
    identity.className = 'player-identity';
    identity.append(title, textElement('small', 'device-id', player.id));
    const stateBadge = textElement('span', 'player-state', player.outOfService ? '使用停止' : !online ? '通信切断' : player.hp === 0 ? '撃破中' : state.simulation ? '仮想接続' : '接続中');
    const header = document.createElement('div');
    header.className = 'player-card-head';
    header.append(identity, stateBadge);

    const score = document.createElement('div');
    score.className = 'player-kills';
    score.textContent = `${player.kills} キル`;

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${player.id} ｜ ${player.connected ? state.simulation ? '仮想接続' : '接続' : '切断'}\n` +
      `${batteryInfo.text}${batteryInfo.status ? ` / ${batteryInfo.status}` : ''} / ` +
      `RSSI ${player.rssi ?? '—'} dBm\n` +
      `構成 ${
        player.hardwareProfile === 'xiao-s3-plus-3rx-6led-motor-trigger' && player.hardwareReady
          ? ['0.8.0-4e42', '0.8.1-4e42', '0.8.2-4e42', '0.8.0-sim'].includes(player.firmwareVersion) ? player.firmwareVersion === '0.8.2-4e42' ? '最新ゲーム版' : '個人戦旧版・更新推奨' : '旧ゲーム版・要更新'
          : player.firmwareVersion === '0.7.1-rx44' && player.hardwareReady ? 'ゲーム用・受信専用（GPIO44）' : '未確認・旧版'
      }${player.bench ? ' / 机上モード' : ''}\n` +
      `受信数 前:${player.rxFrames?.rx1 ?? '—'} ` +
      `左:${player.rxFrames?.rx2 ?? '—'} ` +
      `右:${player.rxFrames?.rx3 ?? '—'}\n` +
      (player.lastIr ? `直近の赤外線 ${player.lastIr.sourceName ?? '未登録'}（銃ID ${player.lastIr.shooterId}）→ ${player.name} / ${player.lastIr.relation === 'OPPONENT' ? '対戦相手' : player.lastIr.relation === 'SELF' ? '自分' : '未登録'} / 連番${player.lastIr.seq}\n` : '直近の赤外線 —\n') +
      `最終命中 ${player.lastReceiver ?? '—'} / ` +
      `振動出力 ${player.motorActive ? 'ON' : 'OFF'}（自己申告）`;
    meta.style.whiteSpace = 'pre-line';

    deviceElements.push(meta);
    const life = textElement('div', 'player-life', player.outOfService ? '故障のため試合に参加しません' : !online ? '端末の電源・Wi-Fiを確認' : player.hp === 0 ? `復活まで ${respawnSeconds} 秒` : state.phase === 'ACTIVE' ? '生存・射撃可能' : state.diagnostics?.enabled ? player.diagnosticMode ? '一時診断に参加中' : '端末の診断適用を待機中' : '接続状態を確認中');
    const stats = textElement('p', 'player-stats', `デス ${player.deaths}  ／  射撃 ${player.shots}  ／  命中率 ${player.accuracy}%`);
    const indicators = document.createElement('div');
    indicators.className = 'device-indicators';
    indicators.append(
      indicator('リミット', !online ? '確認不可' : player.triggerDown ? '押下中' : triggerRecent ? '押下を検知' : player.diagnosticCapable ? '離されている' : '未対応', online && (player.triggerDown || triggerRecent) ? 'active' : 'neutral'),
      indicator('モーター', !online ? '確認不可' : player.motorActive ? '動作中' : motorRecent ? '動作を検知' : player.diagnosticCapable ? '停止中' : '状態のみ', online && (player.motorActive || motorRecent) ? 'active' : 'neutral'),
      indicator('テープLED', !online ? '確認不可' : player.ledColor ? ledNames[player.ledColor] ?? player.ledColor : '未対応', player.ledColor && player.ledColor !== 'OFF' ? 'led-on' : 'neutral'),
      indicator('電池', !online ? '確認不可' : batteryInfo.text),
    );
    const rx = textElement('p', 'player-rx', `赤外線受信　前 ${player.rxFrames?.rx1 ?? '—'} ／ 左 ${player.rxFrames?.rx2 ?? '—'} ／ 右 ${player.rxFrames?.rx3 ?? '—'}`);
    const activity = document.createElement('div');
    activity.className = 'player-activity';
    activity.append(textElement('strong', '', '直近の動作'));
    const entries = activityFor(player);
    const list = document.createElement('ul');
    for (const entry of entries) list.append(textElement('li', '', `${timeLabel(entry.at)}　${entry.text}`));
    if (!entries.length) list.append(textElement('li', 'empty', 'まだ記録がありません'));
    activity.append(list);
    // 故障した銃を試合から外すボタン。カードは更新のたびに作り直すため、クリックは #players で受け取る。
    const service = textElement('button', `service-toggle${player.outOfService ? ' is-resume' : ''}`, player.outOfService ? '使用を再開' : 'この銃を使用停止（故障）');
    service.type = 'button';
    service.dataset.serviceDevice = player.id;
    service.dataset.outOfService = String(!player.outOfService);
    service.disabled = pending || !connected;
    element.append(header, score, life, stats, indicators, rx, activity, service);
    return element;
  });

  // ボタンを押している途中でカードを作り直すとクリックが失われるため、押下中は更新を見送る。
  if (!playerPointerDown) $('players').replaceChildren(...playerElements);
  $('deviceDetails').replaceChildren(...deviceElements);
  $('diagnosticPanel').hidden = !!state.simulation;
  $('diagnosticPanel').classList.toggle('is-active', !!state.diagnostics?.enabled);
  $('diagnosticBadge').textContent = state.diagnostics?.enabled ? '診断中・戦績対象外' : '停止中';
  $('diagnosticToggle').textContent = state.diagnostics?.enabled ? '一時診断を終了' : '一時診断を開始';
  $('diagnosticGuidance').textContent = state.diagnostics?.enabled
    ? `接続した銃のリミットを押して相手の受信部へ向けてください。命中すると相手の銃が振動し、7秒後に復活します。${state.phase === 'PAUSED' ? '診断後、確認してからゲームを再開します。' : state.diagnostics.intermissionHeld ? '次ゲームの自動開始は診断終了まで保留します。' : ''}`
    : state.players.some(player => player.connected && player.diagnosticCapable)
      ? '必要なときだけ開始してください。接続中の対応端末で射撃・受信・振動を確認できます。'
      : '診断対応ファームウェアの端末がまだ接続されていません。';
  $('diagnosticCombat').replaceChildren(...(state.diagnostics?.players ?? []).map(player => {
    const card=textElement('div','diagnostic-fighter','');
    card.classList.toggle('is-defeated',player.hp===0);
    const left=player.hp===0?Math.max(0,Math.ceil((player.respawnAt-state.serverMs)/1000)):0;
    card.append(textElement('strong','',player.name),textElement('span','',`${player.kills} キル ／ ${player.deaths} デス`),textElement('b','',player.hp===0?`撃破・${left}秒で復活`:'生存・射撃可能'));
    return card;
  }));
  const diagnosticEntries = [...(state.diagnostics?.events ?? [])].reverse();
  $('diagnosticLog').replaceChildren(...(diagnosticEntries.length ? diagnosticEntries.map(entry => textElement('li', '', `${timeLabel(entry.at)}　${entry.type === 'shot' ? `${entry.playerName} が診断射撃` : entry.type === 'respawn' ? `${entry.playerName} が自動復活` : `${entry.shooterName} → ${entry.playerName} の${receiverNames[entry.receiverId]}で撃破`}`)) : [textElement('li', 'empty', '診断ログはまだありません')]));
  $('demoPanel').hidden = !state.simulation;
  $('motorDemoPanel').hidden = !state.demo || state.simulation;
  const motorTarget = state.players.find((player) => player.id === $('motorDemoTarget').value);
  $('motorDemoStatus').textContent = motorTarget?.firmwareVersion?.startsWith('legacy-motor-demo-')
    ? `${motorTarget.connected ? '接続中' : '切断'} ／ 射撃 ${motorTarget.demoShots ?? 0}回 ／ 被弾 ${motorTarget.demoHits ?? 0}回 ／ カウントダウン ${motorTarget.demoCountdownBeats ?? 0}拍 ／ HP 0 ${motorTarget.demoDefeats ?? 0}回（${motorTarget.demoDefeatPulses ?? 0}拍）／ 復活 ${motorTarget.demoRevives ?? 0}回 ／ 投影音声 ${state.displayReady ? '準備完了' : '未準備'}`
    : '実機モーターデモの端末を選択してください。';
  const restoredMotor = motorTarget?.firmwareVersion === 'legacy-motor-demo-6';
  const driveProfile = restoredMotor
    ? `旧版モーター制御 ／ 射撃間隔 ${motorTarget.shotCooldownMs ?? 1000} ms ／ 無視した押下 ${motorTarget.ignoredShots ?? 0}回 ／ LED ${motorTarget.ledReady === true ? (motorTarget.ledWhite20 ? '白20%の点灯データ送信済み' : '消灯データ送信済み') : '初期化未完了'}`
    : motorTarget?.motorRunLimit != null
      ? `持続PWM上限 ${motorTarget.motorRunLimit}/255 ／ 始動 ${motorTarget.motorPwmLimit}/255・${motorTarget.motorStartupMs} ms`
      : `PWM上限 ${motorTarget?.motorPwmLimit}/255`;
  $('motorDemoDrive').textContent = motorTarget?.motorPwmLimit != null
    ? `${driveProfile} ／ 現在 ${motorTarget.motorPattern ?? 'OFF'}・PWM ${motorTarget.motorDuty ?? 0}${motorTarget.motorHwDuty != null ? `（読み戻し ${motorTarget.motorHwDuty}）` : ''} ／ 待機 ${motorTarget.motorQueueDepth ?? 0}件 ／ 破棄 ${motorTarget.motorDroppedCommands ?? 0}件${motorTarget.resetReason === 9 ? ' ／ 前回の再起動原因：電圧低下検出' : ''}`
    : 'PWM状態は端末の更新・接続後に表示されます。';

  if (first) {
    for (const id of ['demoShooter', 'demoVictim', 'motorDemoTarget']) {
      for (const player of state.players) {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = player.name;
        $(id).append(option);
      }
    }

    $('demoVictim').value = state.players[2].id;

    first = false;
  }

  for (const id of ['demoShooter', 'demoVictim', 'motorDemoTarget']) {
    for (const player of state.players) {
      const option = [...$(id).options].find((item) => item.value === player.id);
      if (option) option.textContent = player.name;
    }
  }

  disable();
}

function time(milliseconds) {
  const seconds = Math.ceil(milliseconds / 1000);
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secondsText = String(seconds % 60).padStart(2, '0');
  return `${minutesText}:${secondsText}`;
}

document.querySelectorAll('[data-action]').forEach((button) => {
  button.onclick = guarded(async () => {
    if (button.dataset.action === 'finish' && !confirm(state.phase === 'LOBBY' ? '説明動画・試し撃ちを終了して、待機状態に戻します。よろしいですか？' : '試合全体を強制終了します。残りのゲームは行わず、現在の累計キル数で結果を確定します。よろしいですか？')) {
      return;
    }

    await action(button.dataset.action, button.dataset.action === 'start' && state.demo ? {testMode: testRequested()} : {});
  });
});
$('players').addEventListener('pointerdown', (event) => { if (event.target.closest('[data-service-device]')) playerPointerDown = true; });
for (const type of ['pointerup', 'pointercancel']) window.addEventListener(type, () => { setTimeout(() => { playerPointerDown = false; }, 0); });
$('players').addEventListener('click', (event) => {
  const button = event.target.closest('[data-service-device]');
  if (!button || button.disabled) return;
  const player = state?.players.find((item) => item.id === button.dataset.serviceDevice);
  if (!player) return;
  const outOfService = button.dataset.outOfService === 'true';
  const question = outOfService
    ? `${player.name}（${player.id}）の銃を使用停止にします。\nこの銃は試合から外れ、残りの銃で試合を続けます（それまでのキル数は残ります）。よろしいですか？`
    : `${player.name}（${player.id}）の銃の使用を再開します。${['LOBBY', 'FINISHED'].includes(state.phase) ? '' : state.phase === 'PAUSED' ? 'ゲームの再開時から参加します。' : '進行中の試合には次のゲームから参加します。'}よろしいですか？`;
  if (!confirm(question)) return;
  guarded(() => action('device_service', {deviceId: player.id, outOfService}))();
});
$('testMode').onchange = () => { if (state) render(); };
$('dismissAlert').onclick = () => message('');
$('diagnosticToggle').onclick = guarded(() => action(state.diagnostics?.enabled ? 'diagnostic_off' : 'diagnostic_on'));
$('demoSource').onchange = guarded(async (event) => {
  const source = event.target.value;
  try { await action('demo_source', {source}); }
  finally { if (state) render(); }
});

document.querySelectorAll('[data-media]').forEach((button) => {
  button.onclick = guarded(() => action('media', {mode: button.dataset.media}));
});
document.querySelectorAll('[data-video]').forEach((button) => {
  button.onclick = guarded(() => action('video', {operation: button.dataset.video}));
});

$('takeover').onclick = guarded(async () => {
  if (confirm('この端末に操作権を移しますか？')) {
    await post('/api/takeover', {});
  }
});

$('newMatch').onclick = guarded(async () => {
  if (state.phase === 'LOBBY' && !confirm('待機中の3ゲーム戦を作り直します。メンバーを確認し直してください。よろしいですか？')) return;
  await action('new');
});

$('demoHit').onclick = guarded(() =>
  action('demo_hit', {
    shooter: $('demoShooter').value,
    victim: $('demoVictim').value,
    receiver: $('demoReceiver').value,
  }),
);
$('motorDemoHit').onclick = guarded(() => action('motor_demo_hit', {id: $('motorDemoTarget').value}));
$('motorDemoDefeat').onclick = guarded(() => action('motor_demo_defeat', {id: $('motorDemoTarget').value}));
$('motorDemoRevive').onclick = guarded(() => action('motor_demo_revive', {id: $('motorDemoTarget').value}));

$('provisionForm').onsubmit = guarded(async () => {
  const data = Object.fromEntries(new FormData($('provisionForm')));
  const response = await post('/api/provision', data);
  $('provisionForm').elements.password.value = '';
  message(response.message);
});

configureTicketLinks().catch(() => {});
enter().catch((error) => message(error.message, {error: true}));
