const $ = (id) => document.getElementById(id);

let csrf = '';
let sessionId = '';
let state = null;
let connected = false;
let ws;
let first = true;

const message = (text) => {
  $('message').textContent = text;
};

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
  message(`操作を受理しました: ${result.commandId}`);
}

function guarded(callback) {
  return async (event) => {
    event?.preventDefault();

    try {
      await callback(event);
    } catch (error) {
      message(error.message);
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
  ws = new WebSocket(`ws://${location.host}/ws`);

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
    disable();
    setTimeout(connect, 1500);
  };
}

function disable() {
  const locked = !connected || state?.owner !== sessionId;

  document
    .querySelectorAll('#dashboard button:not(#takeover)')
    .forEach((button) => {
      button.disabled = locked;
    });

  $('takeover').disabled = !connected;
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
  $('phase').textContent = names[state.phase];
  $('clock').textContent = time(state.remainingMs);
  $('score').textContent = `A ${state.score.A} : ${state.score.B} B`;
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';

  const connectedPlayers = state.players.filter((player) => player.connected).length;
  $('readiness').textContent =
    `投影: ${state.displayReady ? '準備完了' : '準備が必要'} ／ ` +
    `接続: ${connectedPlayers}/4`;

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

    element.append(title, hp, bar, meta);
    return element;
  });

  $('players').replaceChildren(...playerElements);
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

enter().catch((error) => message(error.message));
