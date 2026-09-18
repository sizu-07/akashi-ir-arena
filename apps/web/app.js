const $ = (id) => document.getElementById(id);

let csrf = '';
let sessionId = '';
let state = null;
let connected = false;
let ws;
let first = true;
let pending = false;

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
  const notices = {start: '開始操作を受け付けました。', pause: '試合を一時停止しました。', finish: '試合を終了しました。', new: '次の試合を準備しました。参加者を確認してください。', sync_ticket_members: '整理券メンバーを反映しました。名前を確認してください。', media: '投影画面を切り替えました。', hp: 'HP補正を記録しました。', demo_hit: '発射・命中を送信しました。'};
  message(result.notice || notices[actionName] || '操作を反映しました。');
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
  $('newMatch').disabled = locked || !['LOBBY', 'FINISHED'].includes(state?.phase);
  document.querySelector('[data-action=start]').disabled = locked || !['LOBBY', 'PAUSED'].includes(state?.phase) || (state?.phase === 'LOBBY' && state?.ticketBridge?.enabled && !state.ticketBridge.membersLoaded);
  document.querySelector('[data-action=pause]').disabled = locked || !['COUNTDOWN', 'ACTIVE'].includes(state?.phase);
  document.querySelector('[data-action=finish]').disabled = locked || state?.phase === 'FINISHED';
  $('rulesForm').querySelector('button').disabled = locked || !['LOBBY', 'FINISHED'].includes(state?.phase);
  $('hpForm').querySelector('button').disabled = locked || !['LOBBY', 'PAUSED'].includes(state?.phase);
}

const names = {
  LOBBY: '待機',
  COUNTDOWN: '開始カウントダウン',
  ACTIVE: '試合中',
  PAUSED: '一時停止',
  FINISHED: '試合終了',
};

function render() {
  $('connection').textContent = state.demo ? '接続済 / デモ' : '接続済';
  $('connection').className = 'badge';
  $('phase').textContent = names[state.phase];
  $('clock').textContent = time(state.remainingMs);
  $('score').textContent = `A ${state.score.A} : ${state.score.B} B`;
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';

  const connectedPlayers = state.players.filter((player) => player.connected).length;
  $('readiness').textContent =
    `投影: ${state.displayReady ? '準備完了' : '準備が必要'} ／ ` +
    `接続: ${connectedPlayers}/4 ／ ` +
    `整理券: ${!state.ticketBridge?.enabled ? '未設定' : state.ticketBridge.connected ? '同期済み' : `未同期（再送待ち${state.ticketBridge.pending}件）`} ／ ` +
    `メンバー: ${!state.ticketBridge?.enabled ? '手動名' : state.ticketBridge.membersLoaded ? '反映済み' : '未反映'}`;
  $('syncTicketMembers').textContent = state.ticketBridge?.membersLoaded ? '整理券メンバーを更新' : '整理券メンバーを反映';
  document.querySelector('[data-action=start]').textContent = state.phase === 'PAUSED' ? '試合を再開' : state.phase === 'COUNTDOWN' ? '開始カウントダウン中' : '試合を開始';
  const hints = {
    LOBBY: state.ticketBridge?.enabled && !state.ticketBridge.membersLoaded ? '整理券メンバーを反映し、参加者の名前を確認してください。' : '参加者・端末を確認し、準備が整ったら「試合を開始」を押してください。',
    COUNTDOWN: '開始カウントダウン中です。異常があれば「一時停止」を押してください。',
    ACTIVE: '試合中です。異常時は「一時停止」、打ち切る場合は「試合終了」を押してください。',
    PAUSED: '一時停止中です。端末と参加者を確認して「試合を再開」を押してください。',
    FINISHED: '試合が終了しました。「次の試合を準備」を押すと、同じルールでHP・残り時間を戻します。',
  };
  $('nextStep').textContent = hints[state.phase];
  if (['LOBBY', 'PAUSED'].includes(state.phase)) {
    if (!state.displayReady) $('nextStep').textContent = '「投影画面を開く」から「表示を準備」を押してください。';
    else if (connectedPlayers < 4) $('nextStep').textContent = `端末が${connectedPlayers}/4台接続されています。4台の接続を確認してください。`;
  }
  document.querySelectorAll('[data-media]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.media === state.media)));

  const deviceElements = [];
  const playerElements = state.players.map((player) => {
    const element = document.createElement('article');
    element.className = `player team${player.team}`;

    const title = document.createElement('h3');
    title.textContent = `${player.team} / ${player.name}`;

    const hp = document.createElement('div');
    hp.className = 'hp';
    hp.textContent = `${player.hp} HP`;

    const bar = document.createElement('progress');
    bar.max = state.rules.hp;
    bar.value = player.hp;
    bar.setAttribute('aria-label', 'HP');

    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.textContent =
      `${player.id} ｜ ${player.connected ? '接続' : '切断'}\n` +
      `残弾 ${player.ammo} / ${state.rules.magazine} ｜ ` +
      `${player.reloadUntil ? 'リロード中' : ''}\n` +
      `電池 ${player.battery?.toFixed(2) ?? '—'} V / ` +
      `RSSI ${player.rssi ?? '—'} dBm\n` +
      `構成 ${
        player.hardwareProfile === 'xiao-s3-plus-3rx-motor' && player.hardwareReady
          ? 'v0.6対応'
          : '未確認・旧版'
      }${player.bench ? ' / 机上モード' : ''}${player.lowBattery ? ' / 電池低下' : ''}\n` +
      `受信数 前:${player.rxFrames?.rx1 ?? '—'} ` +
      `左:${player.rxFrames?.rx2 ?? '—'} ` +
      `右:${player.rxFrames?.rx3 ?? '—'}\n` +
      `最終命中 ${player.lastReceiver ?? '—'} / ` +
      `振動出力 ${player.motorActive ? 'ON' : 'OFF'}（自己申告）`;
    meta.style.whiteSpace = 'pre-line';

    deviceElements.push(meta);
    const summary = document.createElement('div');
    summary.className = 'player-summary';
    summary.textContent = `${player.connected ? '接続済み' : '通信切断'} / 残弾 ${player.ammo}${player.reloadUntil ? '・リロード中' : ''}${player.lowBattery ? ' / 電池低下' : ''}`;
    element.append(title, hp, bar, summary);
    return element;
  });

  $('players').replaceChildren(...playerElements);
  $('deviceDetails').replaceChildren(...deviceElements);
  $('demoPanel').hidden = !state.demo;

  if (first) {
    for (const id of ['hpPlayer', 'demoShooter', 'demoVictim']) {
      for (const player of state.players) {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = `${player.team} / ${player.name}`;
        $(id).append(option);
      }
    }

    $('demoVictim').value = state.players[2].id;

    for (const [key, value] of Object.entries(state.rules)) {
      const input = $('rulesForm').elements[key];

      if (input.type === 'checkbox') {
        input.checked = value;
      } else {
        input.value = value;
      }
    }

    first = false;
  }

  for (const id of ['hpPlayer', 'demoShooter', 'demoVictim']) {
    for (const player of state.players) {
      const option = [...$(id).options].find((item) => item.value === player.id);
      if (option) option.textContent = `${player.team} / ${player.name}`;
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
    if (button.dataset.action === 'finish' && !confirm('試合を終了しますか？')) {
      return;
    }

    await action(button.dataset.action);
  });
});

document.querySelectorAll('[data-media]').forEach((button) => {
  button.onclick = guarded(() => action('media', {mode: button.dataset.media}));
});

$('takeover').onclick = guarded(async () => {
  if (confirm('この端末に操作権を移しますか？')) {
    await post('/api/takeover', {});
  }
});

$('rulesForm').onsubmit = guarded(async () => {
  const rules = {};

  for (const input of $('rulesForm').elements) {
    if (input.name) {
      rules[input.name] = input.type === 'checkbox' ? input.checked : Number(input.value);
    }
  }

  await action('new', {rules});
});

// Normal turnover reuses the actual active rules, not an unsubmitted settings draft.
$('newMatch').onclick = guarded(async () => {
  if (state.phase === 'LOBBY' && !confirm('待機中の試合を作り直します。メンバー反映とHP補正も確認し直してください。よろしいですか？')) return;
  await action('new', {rules: state.rules});
});

$('hpForm').onsubmit = guarded(() =>
  action('hp', {
    id: $('hpPlayer').value,
    hp: Number($('hpValue').value),
    reason: $('hpReason').value,
  }),
);

$('demoHit').onclick = guarded(() =>
  action('demo_hit', {
    shooter: $('demoShooter').value,
    victim: $('demoVictim').value,
    receiver: $('demoReceiver').value,
  }),
);

$('provisionForm').onsubmit = guarded(async () => {
  const data = Object.fromEntries(new FormData($('provisionForm')));
  const response = await post('/api/provision', data);
  $('provisionForm').elements.password.value = '';
  message(response.message);
});

configureTicketLinks().catch(() => {});
enter().catch((error) => message(error.message));
