import {batteryStatus} from './battery-status.js';
const $ = (id) => document.getElementById(id);

let csrf = '';
let sessionId = '';
let state = null;
let connected = false;
let ws;
let first = true;
let pending = false;
let previousDemoSource;
const testRequested = () => state?.demo && ($('testMode')?.checked ?? false);

const message = (text) => {
  $('message').textContent = text;
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
  const notices = {start: '開始操作を受け付けました。', pause: 'ゲームを一時停止しました。', finish: '試合全体を終了しました。', demo_end_round: '現在のゲームを終了しました。', new: '新しい4ゲーム戦を準備しました。', sync_ticket_members: '整理券メンバーを反映しました。名前を確認してください。', media: '投影画面を切り替えました。', demo_hit: '発射・命中を送信しました。', motor_demo_hit: '被弾振動を送信しました。', motor_demo_defeat: '撃破振動を送信しました。', motor_demo_revive: '復活振動を送信しました。'};
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
      message(error.message);
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
    message('');
  };

  ws.onmessage = (event) => {
    state = JSON.parse(event.data);
    render();
  };

  ws.onclose = () => {
    connected = false;
    $('connection').textContent = '通信切断・操作不可';
    $('connection').className = 'badge offline';
    disable();
    setTimeout(connect, 1500);
  };
}

function disable() {
  const locked = pending || !connected || state?.owner !== sessionId;

  document
    .querySelectorAll('#dashboard button:not(#takeover)')
    .forEach((button) => {
      button.disabled = locked;
    });

  $('takeover').disabled = pending || !connected;
  $('syncTicketMembers').disabled = locked || !state?.ticketBridge?.enabled || state?.phase !== 'LOBBY';
  $('newMatch').disabled = locked || !(['LOBBY', 'FINISHED'].includes(state?.phase) || state?.demo && state?.testMode && state?.phase === 'INTERMISSION');
  if ($('testMode')) $('testMode').disabled = locked || state?.phase !== 'LOBBY' || !state?.simulation;
  if ($('demoSource')) $('demoSource').disabled = locked || !['LOBBY', 'FINISHED'].includes(state?.phase) && !(state?.phase === 'INTERMISSION' && state?.testMode);
  document.querySelector('[data-action=start]').disabled = locked || !['LOBBY', 'PAUSED', 'INTERMISSION'].includes(state?.phase) || (state?.phase === 'INTERMISSION' && !state.demo) || (state?.phase === 'LOBBY' && !testRequested() && state?.ticketBridge?.enabled && !state.ticketBridge.membersLoaded);
  document.querySelector('[data-action=pause]').disabled = locked || !['COUNTDOWN', 'ACTIVE'].includes(state?.phase);
  document.querySelector('[data-action=finish]').disabled = locked || !['COUNTDOWN', 'ACTIVE', 'PAUSED', 'INTERMISSION'].includes(state?.phase);
  $('demoEndRound').disabled = locked || !state?.demo || !['ACTIVE', 'PAUSED'].includes(state?.phase);
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

function render() {
  $('connection').textContent = state.demo ? state.simulation ? 'デモ：仮想端末で確認' : 'デモ：接続した実機で確認' : '本番：実機サーバー接続済';
  $('connection').className = 'badge';
  $('phase').textContent = state.testMode && state.phase === 'ACTIVE' ? '動作確認中' : state.testMode && state.phase === 'FINISHED' ? '動作確認終了' : names[state.phase];
  $('clockLabel').textContent = state.phase === 'INTERMISSION' && !state.demo ? '次ゲームまで' : '残り時間';
  $('clock').textContent = state.phase === 'INTERMISSION' && !state.demo && state.intermissionEndsAt
    ? time(Math.max(0, state.intermissionEndsAt - state.serverMs)) : time(state.remainingMs);
  $('roundLabel').textContent = `第${state.round}ゲーム / 全${state.rules.rounds}ゲーム`;
  $('score').textContent = [...state.players].sort((a,b)=>b.kills-a.kills).map(p=>`${p.name} ${p.kills}`).join(' / ');
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';

  const connectedPlayers = state.players.filter((player) => player.connected).length;
  if ($('demoControls')) $('demoControls').hidden = !state.demo;
  $('demoEndRound').hidden = !state.demo;
  $('roundFlow').textContent = state.demo
    ? 'デモではこのゲームを途中で終了して次の途中経過を確認できます。次ゲームの開始と試合全体の終了も手動です。'
    : '各ゲームは90秒。途中経過を15秒表示し、次ゲームのカウントダウンへ自動で進みます。';
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
    `メンバー: ${!state.ticketBridge?.enabled ? '手動名' : state.ticketBridge.membersLoaded ? '反映済み' : '未反映'}`;
  $('syncTicketMembers').textContent = state.ticketBridge?.membersLoaded ? '整理券メンバーを更新' : '整理券メンバーを反映';
  document.querySelector('[data-action=start]').textContent = state.phase === 'PAUSED' ? 'ゲームを再開' : state.phase === 'INTERMISSION' ? state.demo ? `第${state.round}ゲームを開始` : '次ゲームは自動開始' : state.phase === 'COUNTDOWN' ? '開始カウントダウン中' : testRequested() ? '動作確認を開始' : '第1ゲームを開始';
  const hints = {
    LOBBY: state.ticketBridge?.enabled && !state.ticketBridge.membersLoaded ? '整理券メンバーを反映し、参加者の名前を確認してください。' : '参加者・端末を確認し、準備が整ったら「試合を開始」を押してください。',
    COUNTDOWN: '開始カウントダウン中です。異常があれば「一時停止」を押してください。',
    ACTIVE: '試合中です。異常時は「一時停止」、打ち切る場合は「試合全体を強制終了」を押してください。',
    PAUSED: '一時停止中です。端末と参加者を確認して「試合を再開」を押してください。',
    INTERMISSION: state.demo ? `第${state.round-1}ゲームの途中経過を確認し、第${state.round}ゲームを開始してください。` : state.intermissionBlockedReason ? `第${state.round}ゲームの自動開始待ち: ${state.intermissionBlockedReason}` : `途中経過を15秒表示後、第${state.round}ゲームのカウントダウンを自動開始します。`,
    FINISHED: '合計キル数で結果を表示しています。次の4ゲーム戦を準備できます。',
  };
  $('nextStep').textContent = hints[state.phase];
  if (['LOBBY', 'PAUSED'].includes(state.phase)) {
    if (!state.displayReady) $('nextStep').textContent = '「投影画面を開く」から「表示を準備」を押してください。';
    else if (testRequested() || state.testMode) $('nextStep').textContent = `接続中の${connectedPlayers}台で動作確認します。未接続の端末は参加しません。動作確認中は電池低下による停止を解除します。`;
    else if (connectedPlayers < 4) $('nextStep').textContent = `端末が${connectedPlayers}/4台接続されています。通常試合には4台必要です。`;
  }
  if (state.simulation && state.phase === 'LOBBY') $('nextStep').textContent = 'デモモードです。表示中の4台は仮想端末です。実機を確認する場合は、確認対象を「接続した実機」に切り替えてください。';
  document.querySelectorAll('[data-media]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.media === state.media)));

  const deviceElements = [];
  const playerElements = state.players.map((player) => {
    const batteryInfo = batteryStatus(player);
    const element = document.createElement('article');
    element.className = 'player';

    const title = document.createElement('h3');
    title.textContent = player.name;

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
          ? player.firmwareVersion === '0.8.0-4e42' || player.firmwareVersion === '0.8.0-sim' ? '個人戦v0.8対応' : '旧ゲーム版・要更新'
          : player.firmwareVersion === '0.7.1-rx44' && player.hardwareReady ? 'ゲーム用・受信専用（GPIO44）' : '未確認・旧版'
      }${player.bench ? ' / 机上モード' : ''}${player.lowBattery ? ' / 電池低下' : ''}\n` +
      `受信数 前:${player.rxFrames?.rx1 ?? '—'} ` +
      `左:${player.rxFrames?.rx2 ?? '—'} ` +
      `右:${player.rxFrames?.rx3 ?? '—'}\n` +
      (player.lastIr ? `直近の赤外線 ${player.lastIr.sourceName ?? '未登録'}（銃ID ${player.lastIr.shooterId}）→ ${player.name} / ${player.lastIr.relation === 'OPPONENT' ? '対戦相手' : player.lastIr.relation === 'SELF' ? '自分' : '未登録'} / 連番${player.lastIr.seq}\n` : '直近の赤外線 —\n') +
      `最終命中 ${player.lastReceiver ?? '—'} / ` +
      `振動出力 ${player.motorActive ? 'ON' : 'OFF'}（自己申告）`;
    meta.style.whiteSpace = 'pre-line';

    deviceElements.push(meta);
    const summary = document.createElement('div');
    summary.className = 'player-summary';
    const respawnMs=state.phase==='PAUSED' ? player.respawnRemainingMs : player.respawnAt-state.serverMs;
    const respawnSeconds=player.hp===0?Math.max(0,Math.ceil(respawnMs/1000)):0;
    summary.textContent = `${player.hp===0 ? `撃破・あと${respawnSeconds}秒で復活` : player.connected ? state.simulation ? '仮想端末' : '生存・接続済み' : '通信切断'} / デス ${player.deaths} / 射撃 ${player.shots} / 命中率 ${player.accuracy}%${player.lowBattery ? ' / 電池低下' : ''}`;
    const battery = document.createElement('div');
    battery.className = `player-battery${batteryInfo.warning ? ' battery-warning' : ''}`;
    battery.textContent = `${batteryInfo.text}${batteryInfo.status ? ` / ${batteryInfo.status}` : ''}`;
    element.append(title, score, summary, battery);
    return element;
  });

  $('players').replaceChildren(...playerElements);
  $('deviceDetails').replaceChildren(...deviceElements);
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
    if (button.dataset.action === 'finish' && !confirm('試合全体を強制終了します。残りのゲームは行わず、現在の累計キル数で結果を確定します。よろしいですか？')) {
      return;
    }

    await action(button.dataset.action, button.dataset.action === 'start' && state.demo ? {testMode: testRequested()} : {});
  });
});
$('testMode').onchange = () => { if (state) render(); };
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
  if (state.phase === 'LOBBY' && !confirm('待機中の4ゲーム戦を作り直します。メンバーを確認し直してください。よろしいですか？')) return;
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
enter().catch((error) => message(error.message));
