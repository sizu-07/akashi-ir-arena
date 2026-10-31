import {slides as content} from './rules-content.js';

const slides = content.map(([title, ...lines]) => [title, lines.join('\n')]);
const $ = (id) => document.getElementById(id);
const playerNodes = new Map();
const standbyNodes = new Map();
let ws;
let ready = false;
let audio;
let countdownBuffer;
let countdownSource;
let bgmBuffer;
let bgmSource;
let bgmGain;
let bgmFinishedKey = '';
const effectKinds = ['shot', 'hit', 'defeat', 'revive', 'match-end'];
const effectBuffers = new Map();
const effectLoads = new Map();
const effectErrors = new Set();
let lastSoundEventNo = null;
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
let resultBoardKey = '';
let connectionLost = false;
let previousDeviceConnections = null;
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

function syncSoundFiles(files = {}) {
  if (!audio) return Promise.resolve();
  const pending = [];
  for (const kind of effectKinds) {
    const url = files[kind];
    if (!url) {
      effectBuffers.delete(kind);
      effectLoads.delete(kind);
      effectErrors.delete(kind);
      continue;
    }
    if (effectBuffers.get(kind)?.url === url) continue;
    if (effectLoads.get(kind)?.url === url) {
      pending.push(effectLoads.get(kind).promise);
      continue;
    }
    const entry = {url};
    entry.promise = fetch(url, {cache: 'no-store'})
      .then(response => {
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        return response.arrayBuffer();
      })
      .then(data => audio.decodeAudioData(data))
      .then(buffer => {
        if (effectLoads.get(kind) !== entry) return;
        effectBuffers.set(kind, {url, buffer});
        effectErrors.delete(kind);
      })
      .catch(error => {
        if (effectLoads.get(kind) !== entry) return;
        effectErrors.add(kind);
        console.warn(`効果音 ${kind} を読み込めません: ${error.message}`);
      })
      .finally(() => {
        if (effectLoads.get(kind) === entry) effectLoads.delete(kind);
      });
    effectLoads.set(kind, entry);
    pending.push(entry.promise);
  }
  return Promise.all(pending);
}

function playSound(kind) {
  const buffer = effectBuffers.get(kind)?.buffer;
  if (!ready || connectionLost || audio?.state !== 'running' || !buffer) return;
  const source = audio.createBufferSource();
  const gain = audio.createGain();
  source.buffer = buffer;
  gain.gain.value = 0.85;
  source.connect(gain).connect(audio.destination);
  source.onended = () => {source.disconnect(); gain.disconnect();};
  source.start();
}

function playNewSoundEvents() {
  const events = state?.soundEvents || [];
  if (lastSoundEventNo === null) {
    lastSoundEventNo = state?.eventNo ?? Math.max(0, ...events.map(event => event.n));
    return;
  }
  for (const event of events) {
    if (event.n <= lastSoundEventNo || !effectKinds.includes(event.kind)) continue;
    const playIfCurrent = () => {
      if (Date.now() + offset - event.at < 1500) playSound(event.kind);
    };
    const loading = effectLoads.get(event.kind)?.promise;
    if (loading) loading.then(playIfCurrent);
    else playIfCurrent();
  }
  lastSoundEventNo = Math.max(lastSoundEventNo, state?.eventNo ?? 0);
}

$('prepare').onclick = async () => {
  try {
    // Start media playback inside this click's user activation. Audio loading
    // and fullscreen requests below may finish after autoplay permission ends.
    if (state?.media === 'video' && state.videoPlayback?.playing !== false)
      await $('video').play();
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
    await syncSoundFiles(state?.soundFiles);
    if (!document.fullscreenElement)
      await document.documentElement.requestFullscreen?.();
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
  delete document.body.dataset.bgmOffsetMs;
}

function countdownPlaybackMs() {
  // 「表示を準備」をしていない（音声なし）ときは、サーバーの時刻でカウントダウンを進める。
  if (!countdownSource || !audio) return state?.countdownAudioStartAt ? Math.max(0, Date.now() + offset - state.countdownAudioStartAt) : 0;
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

function bgmKey() {
  return `${state.id}/${state.round}/${state.startAt}`;
}

function bgmElapsedSeconds(now) {
  const elapsed = state.rules.durationSec - state.remainingMs / 1000;
  return Math.max(0, state.phase === 'ACTIVE'
    ? state.rules.durationSec - Math.max(0, state.endAt - now) / 1000
    : elapsed + Math.max(0, now - state.startAt) / 1000);
}

function startBgm(offsetSeconds = 0, key = bgmKey()) {
  stopBgm();
  if (!bgmBuffer || !audio) throw Error('BGMが準備されていません');
  if (offsetSeconds >= bgmBuffer.duration) {
    bgmFinishedKey = key;
    document.body.dataset.bgm = 'finished';
    return;
  }
  bgmSource = audio.createBufferSource();
  bgmGain = audio.createGain();
  bgmSource.buffer = bgmBuffer;
  bgmSource.loop = false;
  bgmGain.gain.value = 0.28;
  bgmSource.connect(bgmGain).connect(audio.destination);
  const source = bgmSource;
  source.onended = () => {
    if (bgmSource !== source) return;
    stopBgm();
    bgmFinishedKey = key;
    document.body.dataset.bgm = 'finished';
  };
  bgmSource.start(0, offsetSeconds);
  document.body.dataset.bgm = 'playing';
  document.body.dataset.bgmOffsetMs = String(Math.round(offsetSeconds * 1000));
}

function scheduleStartBurst() {
  const key = `${state.id}/${state.startAt}`;
  clearTimeout(startTimer);
  clearTimeout(burstTimer);
  $('startBurst').hidden = true;
  startTimer = setTimeout(() => {
    startTimer = undefined;
    if (countdownKey !== key || connectionLost || state.media !== 'score' || !['COUNTDOWN', 'ACTIVE'].includes(state.phase)) return;
    if (bgmFinishedKey !== bgmKey()) { try { startBgm(bgmElapsedSeconds(Date.now() + offset)); } catch {} }
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
    lastSoundEventNo = null;
    connectionLost = false;
    document.body.classList.remove('connection-lost');
    acknowledgeReady();
  };
  ws.onmessage = (event) => {
    const nextState = JSON.parse(event.data);
    if (previousDeviceConnections && ['ACTIVE', 'COUNTDOWN'].includes(nextState.phase)) {
      const disconnected = nextState.players.some(player => previousDeviceConnections.get(player.id) === true && !player.connected);
      if (disconnected) { tone(880, 0.18); setTimeout(() => tone(660, 0.18), 250); }
    }
    previousDeviceConnections = new Map(nextState.players.map(player => [player.id, player.connected]));
    state = nextState;
    offset = state.serverMs - Date.now();
    render();
    void syncSoundFiles(state.soundFiles);
    playNewSoundEvents();
  };
  ws.onclose = () => {
    tone(880, 0.18); setTimeout(() => tone(660, 0.18), 250);
    previousDeviceConnections = null;
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
    mediaError = '動画の自動再生が止められました。投影画面の「動画を再生」を押してください';
    $('prepare').textContent = '動画を再生';
    $('prepare').hidden = false;
    acknowledgeReady();
  });
}

function showOverlay(mode, title, text = '', kicker = '') {
  const overlay = $('overlay');
  overlay.hidden = false;
  overlay.className = `mode-${mode}`;
  delete overlay.dataset.result;
  delete overlay.dataset.draw;
  setText('overlayTitle', title);
  setText('overlayText', text);
  setText('overlayKicker', kicker);
  $('overlayKicker').hidden = !kicker;
  $('overlayText').hidden = !text;
  $('resultLead').hidden = true;
  $('resultBoard').hidden = true;
  $('resultMeta').hidden = true;
  $('nextCountdown').hidden = true;
  $('slideProgress').hidden = mode !== 'rules';
}

function showResultOverlay({kind, title, kicker, champion = '', standings, completed = null, meta = '', share = null}) {
  showOverlay('finished', title, '', kicker);
  $('overlay').dataset.result = kind;
  $('resultLead').hidden = !champion;
  setText('resultChampion', champion);
  $('resultBoard').hidden = false;
  $('resultMeta').hidden = !meta;
  setText('resultMeta', meta);
  const key = JSON.stringify({kind, standings: standings.map((player) => [
    player.id, player.name, player.kills, player.deaths, player.shots, player.accuracy, player.outOfService,
    completed?.players.find((entry) => entry.id === player.id),
  ]), share: share && [share.gameId, share.status, share.players]});
  if (key === resultBoardKey) return;
  resultBoardKey = key;
  const rows = standings.map((player, index) => {
    const round = completed?.players.find((entry) => entry.id === player.id);
    const row = document.createElement('li');
    row.className = 'result-row';
    row.classList.toggle('is-leader', player.kills === standings[0]?.kills);
    row.style.setProperty('--player-color', ['#1684a7', '#c45e28', '#6b9c31', '#9a58a7'][player.shooterId - 1] ?? 'var(--red)');
    const rank = document.createElement('span');
    rank.className = 'result-rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    const name = document.createElement('strong');
    name.className = 'result-name';
    name.textContent = player.name;
    if (player.outOfService) {
      const retired = document.createElement('small');
      retired.className = 'result-retired';
      retired.textContent = '故障で欠場';
      name.append(retired);
    }
    const total = document.createElement('span');
    total.className = 'result-total';
    total.textContent = String(player.kills);
    const totalLabel = document.createElement('small');
    totalLabel.textContent = '累計キル';
    total.append(totalLabel);
    const stats = document.createElement('span');
    stats.className = 'result-stats';
    const values = [
      ...(round ? [['今回', `+${round.kills ?? 0}`]] : []),
      ['デス', String(round?.deaths ?? player.deaths)],
      ['射撃', String(round?.shots ?? player.shots)],
      ['命中率', `${round?.accuracy ?? player.accuracy}%`],
    ];
    for (const [label, value] of values) {
      const cell = document.createElement('span');
      const caption = document.createElement('small');
      caption.textContent = label;
      const number = document.createElement('strong');
      number.textContent = value;
      cell.append(caption, number);
      stats.append(cell);
    }
    row.append(rank, name, total, stats);
    // 試合全体の結果では、各プレイヤーの行に本人用の共有QRコードを付ける。
    if (share?.enabled) {
      const cell = document.createElement('span');
      cell.className = 'result-share';
      if (share.players.includes(player.id)) {
        const image = document.createElement('img');
        image.src = `/api/share-qr.svg?device=${encodeURIComponent(player.id)}&game=${encodeURIComponent(share.gameId)}`;
        image.alt = `${player.name}の結果共有QRコード`;
        const caption = document.createElement('small');
        caption.textContent = 'SHARE';
        cell.append(image, caption);
      } else {
        cell.classList.add('is-waiting');
        cell.textContent = share.status === 'failed' ? '共有QRを\n作成できません' : 'QRを\n準備中…';
      }
      row.append(cell);
    }
    return row;
  });
  $('resultBoard').replaceChildren(...rows);
}

function createPlayer(player, index) {
  const element = document.createElement('article');
  // Only fixed markup goes through innerHTML; names from the server use textContent.
  element.innerHTML =
    '<div class="player-top"><span class="player-number"></span><span class="player-state"></span></div><h2></h2><div class="hp-line"><strong class="hp"></strong><span class="hp-label">KILLS / 累計</span><span class="player-sigil" aria-hidden="true"></span></div><div class="player-stats"><span class="deaths"></span><span class="shots"></span><span class="accuracy"></span></div><div class="player-bottom"><span></span></div>';
  const node = {
    element,
    hp: element.querySelector('.hp'),
    name: element.querySelector('h2'),
    number: element.querySelector('.player-number'),
    status: element.querySelector('.player-state'),
    sigil: element.querySelector('.player-sigil'),
    deaths: element.querySelector('.deaths'),
    shots: element.querySelector('.shots'),
    accuracy: element.querySelector('.accuracy'),
    note: element.querySelector('.player-bottom span'),
    previousHp: player.hp,
  };
  node.number.textContent = `RANK ${String(index + 1).padStart(2, '0')} / P${player.shooterId}`;
  element.addEventListener('animationend', () =>
    element.classList.remove('is-hit'),
  );
  return node;
}

function renderPlayers() {
  // Retain the cards between 100 ms clock updates so damage animations can finish.
  const players = state.players.filter((player) => !state.testMode || state.participantIds?.includes(player.id)).sort((a, b) => b.kills-a.kills || a.shooterId-b.shooterId);
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
    node.element.style.setProperty('--player-color', ['#1684a7','#c45e28','#6b9c31','#9a58a7'][player.shooterId-1] ?? '#1684a7');
    node.element.classList.toggle('is-out', player.hp === 0);
    node.element.classList.toggle('is-offline', !player.connected);
    if (player.hp < node.previousHp && state.phase === 'ACTIVE') {
      node.element.classList.remove('is-hit');
      void node.element.offsetWidth;
      node.element.classList.add('is-hit');
    }
    node.previousHp = player.hp;
    node.number.textContent = `RANK ${String(index + 1).padStart(2, '0')} / P${player.shooterId}${player.outOfService ? ' / 欠場' : ''}`;
    node.element.classList.toggle('is-retired', !!player.outOfService);
    node.name.textContent = player.name;
    node.name.classList.toggle('long-name', [...player.name].length > 10);
    node.hp.textContent = player.kills;
    node.sigil.textContent = String(player.shooterId);
    node.deaths.textContent = `デス ${player.deaths}`;
    node.shots.textContent = `射撃 ${player.shots}`;
    node.accuracy.textContent = `命中率 ${player.accuracy}%`;
    node.status.textContent = !player.connected
      ? '接続待ち'
      : player.hp === 0
        ? '復活待ち'
        : state.simulation ? '仮想端末' : '接続済み';
    node.note.textContent =
      player.hp === 0
        ? `あと${Math.max(0,Math.ceil((state.phase==='PAUSED' ? player.respawnRemainingMs : player.respawnAt-(Date.now()+offset))/1000))}秒で自動復活`
          : '受信部を隠さない';
  });
}

function renderStandby() {
  const players = [...state.players].sort((a, b) => a.shooterId - b.shooterId);
  const ids = new Set(players.map((player) => player.id));
  for (const [id, node] of standbyNodes) {
    if (!ids.has(id)) {
      node.element.remove();
      standbyNodes.delete(id);
    }
  }
  players.forEach((player, index) => {
    let node = standbyNodes.get(player.id);
    if (!node) {
      const element = document.createElement('article');
      element.className = 'standby-slot';
      // Names are inserted with textContent so ticket nicknames cannot create markup.
      element.innerHTML = '<span class="standby-slot-number"></span><h3></h3><span class="standby-slot-arrow" aria-hidden="true">↓</span><svg class="standby-figure" viewBox="0 0 200 240" aria-hidden="true" focusable="false"><circle cx="100" cy="53" r="37"/><path d="M99 102c-47 0-83 32-87 83l-6 55h188l-6-55c-4-51-40-83-89-83Z"/></svg><span class="standby-spot"><b></b><span>POSITION</span></span>';
      node = {element, number: element.querySelector('.standby-slot-number'), name: element.querySelector('h3'), spot: element.querySelector('.standby-spot span')};
      standbyNodes.set(player.id, node);
    }
    if ($('standbyLanes').children[index] !== node.element)
      $('standbyLanes').insertBefore(node.element, $('standbyLanes').children[index] ?? null);
    node.element.style.setProperty('--slot-index', index);
    node.element.style.setProperty('--slot-color', ['#1684a7', '#c45e28', '#6b9c31', '#9a58a7'][player.shooterId - 1] ?? 'var(--red)');
    node.number.textContent = `PLAYER ${String(player.shooterId).padStart(2, '0')}`;
    node.name.textContent = player.name;
    node.name.classList.toggle('long-name', [...player.name].length > 10);
    node.spot.textContent = `左から${index + 1}番目に立つ`;
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
    INTERMISSION: '途中経過',
    FINISHED: '試合終了',
  };
  document.body.dataset.phase = state.phase;
  document.body.dataset.media = state.media;
  setText(
    'status',
    connectionLost
      ? 'PCサーバーとの接続が切れました'
      : mediaError ||
          `${state.demo ? state.simulation ? 'デモ・シミュレーター / ' : 'デモ・実機 / ' : ''}${state.testMode ? '動作確認 / ' : ''}${ready ? '表示準備完了' : '表示未準備'}${effectErrors.size ? ` / 効果音の読込失敗: ${[...effectErrors].join('、')}` : ''}`,
  );
  $('pair').hidden = ['ACTIVE', 'COUNTDOWN'].includes(state.phase);
  if ($('pair').hidden) $('pair').open = false;
  setText('phase', connectionLost ? '接続切断' : state.testMode && state.phase === 'ACTIVE' ? '動作確認中' : state.testMode && state.phase === 'FINISHED' ? '動作確認終了' : phaseNames[state.phase]);
  const milliseconds =
    state.phase === 'ACTIVE' && !connectionLost
      ? Math.max(0, state.endAt - now)
      : state.remainingMs;
  const displayMilliseconds = Math.ceil(milliseconds * (state.rules.displayDurationSec ?? state.rules.durationSec) / state.rules.durationSec);
  const seconds = Math.ceil(displayMilliseconds / 1000);
  setText(
    'clock',
    `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`,
  );
  const ranking = [...state.players].sort((a, b) => b.kills - a.kills);
  setText('round', `${Math.min(state.round, state.rules.rounds)} / ${state.rules.rounds}`);
  setText('leader', ranking.length > 1 && ranking[0].kills === ranking[1].kills ? '同率' : ranking[0]?.name ?? '—');
  $('score').setAttribute('aria-label', `第${state.round}ゲーム。${ranking.map(p => `${p.name} ${p.kills}キル`).join('、')}`);
  $('timeProgress').style.transform =
    `scaleX(${Math.max(0, Math.min(1, milliseconds / (state.rules.durationSec * 1000)))})`;
  $('clock').parentElement.classList.toggle(
    'urgent',
    state.phase === 'ACTIVE' && seconds <= 30,
  );
  const matchNotes = {
      LOBBY: 'STAND BY — 開始の合図を待て',
      COUNTDOWN: 'GET READY — まもなく開始',
      ACTIVE: 'LIVE BATTLE — その一撃で、流れを変えろ',
      PAUSED: 'HOLD ON — 運営の合図を待て',
      INTERMISSION: 'ROUND RESULT — 途中経過',
      FINISHED: 'BATTLE OVER — 試合終了',
    };
  setText('matchNote', state.testMode ? {
    LOBBY: 'DEVICE TEST — 準備待ち',
    COUNTDOWN: 'DEVICE TEST — まもなく開始',
    ACTIVE: 'DEVICE TEST — 動作確認中',
    PAUSED: 'DEVICE TEST — 一時停止中',
    INTERMISSION: 'DEVICE TEST — 途中経過',
    FINISHED: 'DEVICE TEST — 動作確認終了',
  }[state.phase] : matchNotes[state.phase]);
  renderPlayers();
  renderStandby();

  if (state.phase === 'ACTIVE' && state.media === 'score' && ready && !connectionLost &&
      !bgmSource && !startTimer && bgmFinishedKey !== bgmKey()) {
    startBgm(bgmElapsedSeconds(now));
  }

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
  $('video').hidden = state.media !== 'video';
  if (state.media === 'video' && !connectionLost) syncVideo(now);
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
        // 音声がなくても表示のカウントダウンとSTART演出は進める。
        scheduleStartBurst();
        ready = false;
        mediaError = `${error.message}（音声なしで表示しています）。音声を出す場合は「表示を準備」を押してください`;
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
  } else if (state.phase === 'INTERMISSION') {
    const completed = state.roundResults.at(-1);
    const standings = [...state.players].sort((a, b) => b.kills - a.kills || a.shooterId - b.shooterId);
    const nextSeconds = Number.isFinite(state.intermissionEndsAt) ? Math.max(0, Math.ceil((state.intermissionEndsAt - now) / 1000)) : null;
    showResultOverlay({
      kind: 'intermission', title: '途中経過',
      kicker: `ROUND ${String(completed?.round ?? state.round - 1).padStart(2, '0')} / GAME RESULT`,
      standings, completed,
      // 結果を見たら、次のゲームに備えてスタート地点へ戻るよう毎回伝える。
      meta: `結果を確認したら、自分のスタート地点へ戻ってください${state.demo ? ' ／ 次のゲームは運営の合図で開始'
        : state.intermissionBlockedReason ? ` ／ ${state.intermissionBlockedReason}`
          : nextSeconds === null ? ' ／ まもなく開始' : ''}`,
    });
    // 次のゲームまでの残り秒数は結果表の横に大きく出す（自動進行のときだけ）。
    const counting = !state.demo && !state.intermissionBlockedReason && nextSeconds !== null;
    $('nextCountdown').hidden = !counting;
    if (counting) {
      setText('nextRound', String(state.round).padStart(2, '0'));
      setText('nextSeconds', String(nextSeconds));
      $('nextCountdown').classList.toggle('is-final', nextSeconds <= 5);
    }
  } else if (state.phase === 'FINISHED') {
    if (state.testMode) {
      $('overlay').dataset.draw = 'true';
      showOverlay('finished', '動作確認終了', `接続端末 ${state.participantIds?.length ?? 0}台`, 'TEST COMPLETE / 試合判定なし');
    } else {
      const draw = state.winner === 'DRAW';
      const winner = state.players.find(p => p.id === state.winner);
      const standings = [...state.players].sort((a, b) => b.kills - a.kills || a.shooterId - b.shooterId);
      showResultOverlay({
        kind: 'final', title: draw ? '同率優勝' : '優勝',
        kicker: draw ? 'FINAL RESULT / TIE FOR FIRST' : 'FINAL RESULT / WINNER',
        champion: draw ? '' : winner?.name ?? '', standings, share: state.share,
        meta: state.share?.enabled && state.share.status !== 'failed'
          ? `${state.rules.rounds}ゲームの合計キル数で決着 ／ 自分の名前の横のQRを読み取って結果をシェア！ #明石光線`
          : `${state.rules.rounds} GAMES / 合計キル数で決着`,
      });
      $('overlay').dataset.draw = String(draw);
    }
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
    lastPhase = state.phase;
  }
}

$('video').onerror = () => {
  if (state?.media !== 'video') return;
  ready = false;
  acknowledgeReady();
  $('prepare').hidden = false;
  mediaError = '動画を読み込めません。PCの assets/rules-intro.webm または assets/rules.webm を確認してください';
  render();
};
$('pair').ontoggle = async () => {
  if (!$('pair').open) return;
  try {
    const response = await fetch('/api/pair-info', {cache: 'no-store'});
    if (!response.ok) throw Error(`HTTP ${response.status}`);
    $('pairUrl').textContent = (await response.json()).url;
    $('qr').src = `/api/pair.svg?t=${Date.now()}`;
  } catch { $('pairUrl').textContent = '接続先を取得できません'; }
};
setInterval(acknowledgeReady, 1000);
setInterval(render, 100);
connect();
