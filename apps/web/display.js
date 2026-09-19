import {slides as content} from './rules-content.js';

const slides = content.map(([title, ...lines]) => [title, lines.join('\n')]);
const $ = (id) => document.getElementById(id);
const playerNodes = new Map();
let ws;
let ready = false;
let audio;
let countdownBuffer;
let countdownSource;
let bgmBuffer;
let bgmSource;
let bgmGain;
let countdownAudioStartedAt = 0;
let countdownAudioOffset = 0;
let state;
let offset = 0;
let lastPhase = '';
let lastMedia = '';
let lastVideoCommand = '';
let slideStart = 0;
let lastSlide = -1;
let countdownKey = '';
let countdownVisual = '';
let connectionLost = false;
let mediaError = '';
let burstTimer;
let startTimer;
const countdownMarks = [
  {at: 0, label: 'READY?', directive: 'STAND BY'},
  {at: 1460, label: '5', directive: 'READY'},
  {at: 3080, label: '4', directive: 'READY'},
  {at: 4080, label: '3', directive: 'READY'},
  {at: 5100, label: '2', directive: 'AIM'},
  {at: 6140, label: '1', directive: 'LOCK ON'},
];

function tone(frequency = 660, duration = 0.15) {
  if (!audio || audio.state !== 'running') return;
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
    if (!countdownBuffer) {
      const response = await fetch('/countdown.wav');
      if (!response.ok) throw Error('カウントダウン音声を読み込めません');
      countdownBuffer = await audio.decodeAudioData(await response.arrayBuffer());
    }
    if (!bgmBuffer) {
      const response = await fetch('/bgm.mp3');
      if (!response.ok) throw Error('BGMを読み込めません');
      bgmBuffer = await audio.decodeAudioData(await response.arrayBuffer());
    }
    if (!document.fullscreenElement)
      await document.documentElement.requestFullscreen?.();
    if (state?.media === 'video' && state.videoPlayback?.playing !== false) await $('video').play();
    mediaError = '';
    ready = true;
    $('prepare').hidden = true;
    tone();
    acknowledgeReady();
  } catch (error) {
    mediaError = `準備失敗: ${error.message}。再操作してください`;
    ready = false;
    acknowledgeReady();
    render();
  }
};

function acknowledgeReady() {
  if (ws?.readyState === 1) ws.send(JSON.stringify({type: 'ready', ready}));
}

function stopCountdownAudio(reset = false) {
  if (countdownSource) {
    try { countdownSource.stop(); } catch {}
    countdownSource.disconnect();
    countdownSource = undefined;
  }
  if (reset) {
    countdownAudioStartedAt = 0;
    countdownAudioOffset = 0;
    delete document.body.dataset.countdownMs;
  }
}

function stopBgm() {
  if (bgmSource) {
    try { bgmSource.stop(); } catch {}
    bgmSource.disconnect();
    bgmGain?.disconnect();
  }
  bgmSource = undefined;
  bgmGain = undefined;
  delete document.body.dataset.bgm;
}

function countdownPlaybackMs() {
  if (!countdownSource || !audio) return 0;
  return (countdownAudioOffset + audio.currentTime - countdownAudioStartedAt) * 1000;
}

function startCountdownAudio(now) {
  stopCountdownAudio();
  stopBgm();
  if (!countdownBuffer || !bgmBuffer || !audio) throw Error('音声が準備されていません');
  countdownAudioOffset = Math.max(0, now - state.countdownAudioStartAt) / 1000;
  countdownAudioStartedAt = audio.currentTime;
  countdownSource = audio.createBufferSource();
  countdownSource.buffer = countdownBuffer;
  countdownSource.connect(audio.destination);
  countdownSource.start(0, Math.min(countdownAudioOffset, countdownBuffer.duration));
}

function startBgm(offsetSeconds = 0) {
  stopBgm();
  if (!bgmBuffer || !audio) throw Error('BGMが準備されていません');
  bgmSource = audio.createBufferSource();
  bgmGain = audio.createGain();
  bgmSource.buffer = bgmBuffer;
  bgmSource.loop = true;
  bgmGain.gain.value = 0.28;
  bgmSource.connect(bgmGain).connect(audio.destination);
  bgmSource.start(0, offsetSeconds % bgmBuffer.duration);
  document.body.dataset.bgm = 'playing';
}

function scheduleStartBurst() {
  const key = `${state.id}/${state.startAt}`;
  clearTimeout(startTimer);
  clearTimeout(burstTimer);
  $('startBurst').hidden = true;
  startTimer = setTimeout(() => {
    if (countdownKey !== key || connectionLost || state.media !== 'score' || !['COUNTDOWN', 'ACTIVE'].includes(state.phase)) return;
    startBgm(Math.max(0, countdownPlaybackMs() - 7010) / 1000);
    $('startBurst').hidden = false;
    burstTimer = setTimeout(() => {
      $('startBurst').hidden = true;
    }, 900);
  }, Math.max(0, 7010 - countdownPlaybackMs()));
}

function connect() {
  ws = new WebSocket(
    `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/display`,
  );
  ws.onopen = () => {
    lastVideoCommand = '';
    connectionLost = false;
    document.body.classList.remove('connection-lost');
    acknowledgeReady();
  };
  ws.onmessage = (event) => {
    state = JSON.parse(event.data);
    offset = state.serverMs - Date.now();
    render();
  };
  ws.onclose = () => {
    connectionLost = true;
    document.body.classList.add('connection-lost');
    $('status').textContent = 'PCサーバーとの接続が切れました';
    ready = false;
    $('prepare').hidden = false;
    $('startBurst').hidden = true;
    clearTimeout(startTimer);
    clearTimeout(burstTimer);
    stopCountdownAudio();
    stopBgm();
    render();
    setTimeout(connect, 1500);
  };
}

function setText(id, value) {
  const element = $(id);
  if (element.textContent !== String(value)) element.textContent = value;
}

function syncVideo(now) {
  const video = $('video');
  const playback = state.videoPlayback;
  const command = playback?.commandId || 'initial';
  if (lastVideoCommand === command) return;
  if (video.readyState < 1) return;
  lastVideoCommand = command;
  mediaError = '';
  const position = playback ? (playback.positionMs +
    (playback.playing ? Math.max(0, now - playback.updatedAt) : 0)) / 1000 : 0;
  video.currentTime = Math.min(position, Number.isFinite(video.duration) ? video.duration : position);
  if (playback?.playing === false) {
    video.pause();
    return;
  }
  video.play().catch(() => {
    if (state.media !== 'video' || state.videoPlayback?.playing === false ||
        lastVideoCommand !== command || connectionLost) return;
    ready = false;
    mediaError = '動画再生失敗。PCで表示を再準備してください';
    $('prepare').hidden = false;
    acknowledgeReady();
  });
}

function showOverlay(mode, title, text = '', kicker = '') {
  const overlay = $('overlay');
  overlay.hidden = false;
  overlay.className = `mode-${mode}`;
  setText('overlayTitle', title);
  setText('overlayText', text);
  setText('overlayKicker', kicker);
  $('overlayKicker').hidden = !kicker;
  $('overlayText').hidden = !text;
  $('slideProgress').hidden = mode !== 'rules';
}

function createPlayer(player, index) {
  const element = document.createElement('article');
  // Only fixed markup goes through innerHTML; names from the server use textContent.
  element.innerHTML =
    '<div class="player-top"><span class="player-number"></span><span class="player-state"></span></div><h2></h2><div class="hp-line"><strong class="hp"></strong><span class="hp-label">HP</span><span class="hp-limit"></span><span class="player-sigil" aria-hidden="true"></span></div><div class="hp-track" role="meter"><div class="hp-fill"></div></div><div class="player-bottom"><span></span><span></span></div>';
  const node = {
    element,
    hp: element.querySelector('.hp'),
    name: element.querySelector('h2'),
    number: element.querySelector('.player-number'),
    status: element.querySelector('.player-state'),
    limit: element.querySelector('.hp-limit'),
    sigil: element.querySelector('.player-sigil'),
    meter: element.querySelector('.hp-track'),
    fill: element.querySelector('.hp-fill'),
    ammo: element.querySelector('.player-bottom span'),
    note: element.querySelector('.player-bottom span:last-child'),
    previousHp: player.hp,
  };
  node.number.textContent = `P${String(index + 1).padStart(2, '0')} / TEAM ${player.team}`;
  element.addEventListener('animationend', () =>
    element.classList.remove('is-hit'),
  );
  return node;
}

function renderPlayers() {
  // Retain the cards between 100 ms clock updates so damage animations can finish.
  const players = [...state.players].sort((a, b) =>
    a.team.localeCompare(b.team),
  );
  const ids = new Set(players.map((player) => player.id));
  for (const [id, node] of playerNodes) {
    if (!ids.has(id)) {
      node.element.remove();
      playerNodes.delete(id);
    }
  }
  players.forEach((player, index) => {
    let node = playerNodes.get(player.id);
    if (!node) {
      node = createPlayer(player, index);
      playerNodes.set(player.id, node);
    }
    if ($('players').children[index] !== node.element)
      $('players').insertBefore(
        node.element,
        $('players').children[index] ?? null,
      );
    node.element.classList.add('player');
    node.element.classList.toggle('teamA', player.team === 'A');
    node.element.classList.toggle('teamB', player.team === 'B');
    node.element.classList.toggle('is-out', player.hp === 0);
    node.element.classList.toggle(
      'is-low',
      player.hp > 0 && player.hp <= state.rules.hp * 0.25,
    );
    node.element.classList.toggle('is-offline', !player.connected);
    if (player.hp < node.previousHp && state.phase === 'ACTIVE') {
      node.element.classList.remove('is-hit');
      void node.element.offsetWidth;
      node.element.classList.add('is-hit');
    }
    node.previousHp = player.hp;
    node.number.textContent = `P${String(index + 1).padStart(2, '0')} / TEAM ${player.team}`;
    node.name.textContent = player.name;
    node.name.classList.toggle('long-name', [...player.name].length > 10);
    node.hp.textContent = player.hp;
    node.limit.textContent = `/ ${state.rules.hp}`;
    node.sigil.textContent = player.team;
    node.status.textContent = !player.connected
      ? '接続待ち'
      : player.hp === 0
        ? '撃破'
        : '接続済み';
    node.fill.style.transform = `scaleX(${Math.max(0, Math.min(1, player.hp / state.rules.hp))})`;
    node.meter.setAttribute('aria-label', `${player.name} HP`);
    node.meter.setAttribute('aria-valuemin', '0');
    node.meter.setAttribute('aria-valuemax', state.rules.hp);
    node.meter.setAttribute('aria-valuenow', player.hp);
    node.ammo.textContent = `AMMO ${String(player.ammo).padStart(2, '0')} / ${state.rules.magazine}`;
    node.note.textContent =
      player.hp === 0
        ? '射撃停止'
        : player.reloadUntil
          ? 'リロード中'
          : '受信部を隠さない';
  });
}

function render() {
  if (!state) return;
  const now = Date.now() + offset;
  const phaseNames = {
    LOBBY: '対戦準備',
    COUNTDOWN: 'まもなく開始',
    ACTIVE: '対戦中',
    PAUSED: '一時停止',
    FINISHED: '試合終了',
  };
  document.body.dataset.phase = state.phase;
  document.body.dataset.media = state.media;
  setText(
    'status',
    connectionLost
      ? 'PCサーバーとの接続が切れました'
      : mediaError ||
          `${state.demo ? 'シミュレーター / ' : ''}${ready ? '表示準備完了' : '表示未準備'}`,
  );
  $('pair').hidden = ['ACTIVE', 'COUNTDOWN'].includes(state.phase);
  if ($('pair').hidden) $('pair').open = false;
  setText('phase', connectionLost ? '接続切断' : phaseNames[state.phase]);
  const milliseconds =
    state.phase === 'ACTIVE' && !connectionLost
      ? Math.max(0, state.endAt - now)
      : state.remainingMs;
  const seconds = Math.ceil(milliseconds / 1000);
  setText(
    'clock',
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
  );
  setText('scoreA', String(state.score.A).padStart(2, '0'));
  setText('scoreB', String(state.score.B).padStart(2, '0'));
  $('score').setAttribute(
    'aria-label',
    `撃破数 A ${state.score.A} 対 B ${state.score.B}`,
  );
  $('timeProgress').style.transform =
    `scaleX(${Math.max(0, Math.min(1, milliseconds / (state.rules.durationSec * 1000)))})`;
  $('clock').parentElement.classList.toggle(
    'urgent',
    state.phase === 'ACTIVE' && seconds <= 30,
  );
  setText(
    'matchNote',
    {
      LOBBY: 'STAND BY — 開始の合図を待て',
      COUNTDOWN: 'GET READY — まもなく開始',
      ACTIVE: 'LIVE BATTLE — その一撃で、流れを変えろ',
      PAUSED: 'HOLD ON — 運営の合図を待て',
      FINISHED: 'BATTLE OVER — 試合終了',
    }[state.phase],
  );
  renderPlayers();

  if (lastMedia !== state.media) {
    mediaError = '';
    if (state.media === 'rules') {
      slideStart = now;
      lastSlide = -1;
    }
    lastVideoCommand = '';
    if (state.media !== 'video') $('video').pause();
    lastMedia = state.media;
  }
  if (state.media === 'video' && !connectionLost) syncVideo(now);
  $('video').hidden = state.media !== 'video';
  $('overlay').hidden = true;

  if (connectionLost) {
    showOverlay(
      'paused',
      '接続切断',
      'PCサーバーとの再接続を待っています',
      'CONNECTION LOST',
    );
    $('video').hidden = true;
    $('video').pause();
  } else if (state.media === 'black') {
    showOverlay('black', '');
  } else if (state.media === 'video') {
    // Video owns the entire projection until the operator changes media.
  } else if (state.phase === 'COUNTDOWN') {
    let newCountdown = false;
    if (countdownKey !== `${state.id}/${state.startAt}`) {
      countdownKey = `${state.id}/${state.startAt}`;
      countdownVisual = '';
      newCountdown = true;
    }
    if (newCountdown) {
      try {
        startCountdownAudio(now);
        scheduleStartBurst();
      } catch (error) {
        ready = false;
        mediaError = `${error.message}。「表示を準備」を押し直してください`;
        $('prepare').hidden = false;
        acknowledgeReady();
      }
    }
    const elapsed = countdownPlaybackMs();
    document.body.dataset.countdownMs = String(Math.round(elapsed));
    const mark = countdownMarks.findLast((item) => elapsed >= item.at) || countdownMarks[0];
    showOverlay(
      'countdown',
      mark.label,
      '受信部を隠さず、開始の合図を待ってください',
      'GET READY / 開戦準備',
    );
    $('overlay').dataset.count = mark.label;
    setText('countDirective', mark.directive);
    setText('countEcho', mark.label);
    if (mark.label !== countdownVisual) {
      for (const animation of document
        .querySelector('.title-wrap')
        .getAnimations())
        animation.currentTime = 0;
      countdownVisual = mark.label;
    }
  } else if (state.media === 'rules') {
    const slideIndex = Math.floor((now - slideStart) / 7000) % slides.length;
    showOverlay(
      'rules',
      ...slides[slideIndex],
      `HOW TO PLAY / ${String(slideIndex + 1).padStart(2, '0')}`,
    );
    if (lastSlide !== slideIndex) {
      $('slideProgress').replaceChildren(
        ...slides.map((_, index) => {
          const mark = document.createElement('i');
          mark.className = index === slideIndex ? 'current' : '';
          return mark;
        }),
      );
      lastSlide = slideIndex;
    }
  } else if (state.phase === 'PAUSED') {
    showOverlay(
      'paused',
      '一時停止',
      '運営の合図を待ってください',
      'HOLD ON / 射撃をやめてください',
    );
  } else if (state.phase === 'FINISHED') {
    const draw = state.winner === 'DRAW';
    $('overlay').dataset.draw = String(draw);
    showOverlay(
      'finished',
      draw ? '引き分け' : `TEAM ${state.winner} WIN`,
      `撃破数　A ${state.score.A} : ${state.score.B} B`,
      draw ? 'DRAW GAME / 試合終了' : 'WINNER / 勝利チーム',
    );
  }

  if (lastPhase !== state.phase) {
    if (!['COUNTDOWN', 'ACTIVE'].includes(state.phase)) {
      clearTimeout(startTimer);
      startTimer = undefined;
      clearTimeout(burstTimer);
      $('startBurst').hidden = true;
      stopCountdownAudio(true);
      stopBgm();
    }
    if (state.phase === 'FINISHED') tone(400, 0.7);
    lastPhase = state.phase;
  }
}

$('video').onerror = () => {
  if (state?.media !== 'video') return;
  ready = false;
  acknowledgeReady();
  $('prepare').hidden = false;
  mediaError = '動画を読み込めません。assets/rules.mp4を確認してください';
  render();
};
setInterval(acknowledgeReady, 1000);
setInterval(render, 100);
connect();
