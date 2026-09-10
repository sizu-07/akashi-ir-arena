import {slides as content} from './rules-content.js';

const slides = content.map(([title, ...lines]) => [title, lines.join(' ')]);
const $ = (id) => document.getElementById(id);

let ws;
let ready = false;
let audio;
let state;
let offset = 0;
let lastPhase = '';
let lastMedia = '';
let slideStart = 0;
let lastCount = -1;

function tone(frequency = 660, duration = 0.15) {
  if (!audio || audio.state !== 'running') {
    return;
  }

  const oscillator = audio.createOscillator();
  const gain = audio.createGain();

  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.08, audio.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + duration);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start();
  oscillator.stop(audio.currentTime + duration);
}

$('prepare').onclick = async () => {
  try {
    audio ??= new AudioContext();
    await audio.resume();
    await document.documentElement.requestFullscreen?.();
    ready = true;
    $('prepare').hidden = true;
    tone();
    acknowledgeReady();
  } catch (error) {
    $('status').textContent = `準備失敗: ${error.message}。再操作してください`;
  }
};

function acknowledgeReady() {
  if (ws?.readyState === 1) {
    ws.send(JSON.stringify({type: 'ready', ready}));
  }
}

function connect() {
  ws = new WebSocket(`ws://${location.host}/ws/display`);
  ws.onopen = acknowledgeReady;

  ws.onmessage = (event) => {
    state = JSON.parse(event.data);
    offset = state.serverMs - Date.now();
    render();
  };

  ws.onclose = () => {
    $('status').textContent = 'PCサーバーとの接続が切れました';
    ready = false;
    $('prepare').hidden = false;
    setTimeout(connect, 1500);
  };
}

function showOverlay(title, text = '') {
  $('overlay').hidden = false;
  $('overlayTitle').textContent = title;
  $('overlayText').textContent = text;
}

function render() {
  if (!state) {
    return;
  }

  const now = Date.now() + offset;
  const phaseNames = {
    LOBBY: '対戦準備',
    COUNTDOWN: 'まもなく開始',
    ACTIVE: '対戦中',
    PAUSED: '一時停止',
    FINISHED: '試合終了',
  };

  $('status').textContent =
    `${state.demo ? 'シミュレーター / ' : ''}` +
    `${ready ? '表示準備完了' : '表示未準備'}`;
  $('pair').hidden = state.phase === 'ACTIVE' || state.phase === 'COUNTDOWN';
  $('phase').textContent = phaseNames[state.phase];

  const milliseconds =
    state.phase === 'ACTIVE' ? Math.max(0, state.endAt - now) : state.remainingMs;
  const seconds = Math.ceil(milliseconds / 1000);
  const minutesText = String(Math.floor(seconds / 60)).padStart(2, '0');
  const secondsText = String(seconds % 60).padStart(2, '0');

  $('clock').textContent = `${minutesText}:${secondsText}`;
  $('score').textContent = `A ${state.score.A} : ${state.score.B} B`;

  const playerElements = state.players.map((player) => {
    const element = document.createElement('article');
    element.className = `player team${player.team}`;

    const heading = document.createElement('h2');
    heading.textContent = `${player.team} / ${player.name}`;

    const hp = document.createElement('div');
    hp.className = 'hp';
    hp.textContent = player.hp;

    const text = document.createElement('p');
    text.textContent = player.hp === 0 ? '撃破' : player.connected ? 'HP' : '接続待ち';

    element.append(heading, hp, text);
    return element;
  });

  $('players').replaceChildren(...playerElements);
  $('overlay').hidden = true;
  $('video').hidden = state.media !== 'video';

  if (lastMedia !== state.media) {
    if (state.media === 'rules') {
      slideStart = now;
    }

    if (state.media === 'video') {
      $('video').currentTime = 0;
      $('video')
        .play()
        .catch(() => {
          ready = false;
          $('status').textContent = '動画再生失敗。PCで表示を再準備してください';
          $('prepare').hidden = false;
          acknowledgeReady();
        });
    } else {
      $('video').pause();
    }

    lastMedia = state.media;
  }

  if (state.media === 'rules') {
    const slideIndex = Math.floor((now - slideStart) / 7000) % slides.length;
    showOverlay(...slides[slideIndex]);
  }

  if (state.media === 'black') {
    showOverlay('');
  }

  if (state.phase === 'COUNTDOWN') {
    const count = Math.max(1, Math.ceil((state.startAt - now) / 1000));
    showOverlay(String(count), '受信部を隠さず、開始の合図を待ってください');

    if (count !== lastCount) {
      tone(600, 0.12);
      lastCount = count;
    }
  }

  if (state.phase === 'PAUSED') {
    showOverlay('一時停止', '運営の合図を待ってください');
  }

  if (state.phase === 'FINISHED') {
    const resultTitle = state.winner === 'DRAW' ? '引き分け' : `TEAM ${state.winner} WIN`;
    showOverlay(resultTitle, `撃破数 A ${state.score.A} : ${state.score.B} B`);
  }

  if (lastPhase !== state.phase) {
    if (state.phase === 'ACTIVE') {
      tone(1000, 0.6);
    }

    if (state.phase === 'FINISHED') {
      tone(400, 0.7);
    }

    lastPhase = state.phase;
  }
}

$('video').onerror = () => {
  if (state?.media === 'video') {
    ready = false;
    acknowledgeReady();
    $('prepare').hidden = false;
    $('status').textContent = '動画を読み込めません。assets/rules.mp4を確認してください';
  }
};

setInterval(acknowledgeReady, 1000);
setInterval(render, 100);
connect();
