const $ = (id) => document.getElementById(id);
const labels = {
  WAITING: '待機', ASSIGNED: '割当済', CALLED: '呼出中', CHECKED_IN: '入場済', PLAYING: '体験中',
  COMPLETED: '終了', ON_HOLD: '保留', NO_SHOW: '来場なし', CANCELED: '取消', EXPIRED: '失効',
  SCHEDULED: '予定', LOCKED_SCHEDULED: '時刻固定',
};
const activeTicketStates = new Set(['WAITING', 'ASSIGNED', 'CALLED', 'CHECKED_IN', 'PLAYING', 'ON_HOLD']);
const scheduledRoundStates = new Set(['SCHEDULED', 'LOCKED_SCHEDULED']);
const commandId = () => `${Date.now()}-${crypto.randomUUID()}`;
const formatTime = (value) => value ? new Date(value).toLocaleTimeString('ja-JP', {hour: '2-digit', minute: '2-digit'}) : '時刻計算中';
let csrf = '';
let sessionId = '';
let state;
let socket;
let heartbeat;
let selectedTicket;

const gameFromQuery = new URLSearchParams(location.search).get('game');
if (gameFromQuery && /^https?:\/\/[^/]+\/?$/.test(gameFromQuery)) localStorage.setItem('akashi-game-operator-url', gameFromQuery);
const gameOperatorUrl = localStorage.getItem('akashi-game-operator-url') || 'http://localhost:8080/';
$('gameOperatorTab').href = gameOperatorUrl;
$('gameActionLink').href = gameOperatorUrl;

const showMessage = (text, ok = false) => {
  $('message').textContent = text;
  $('message').className = ok ? 'success' : 'error';
};
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '操作に失敗しました');
  return result;
}
async function post(url, data) {
  return request(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf}, body: JSON.stringify(data)});
}
async function action(actionName, extra = {}) {
  const result = await post('/api/operator/action', {action: actionName, commandId: commandId(), ...extra});
  showMessage(`操作を反映しました（${result.commandId}）`, true);
}
function guarded(callback) {
  return async (event) => {
    event?.preventDefault();
    try { await callback(event); } catch (error) { showMessage(error.message); }
  };
}

$('loginForm').addEventListener('submit', guarded(async () => {
  const password = new FormData($('loginForm')).get('password');
  const result = await request('/api/operator/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({password})});
  csrf = result.csrf;
  sessionId = result.id;
  $('loginForm').reset();
  await enter();
}));

async function enter() {
  const session = await request('/api/operator/session');
  csrf = session.csrf;
  sessionId = session.id;
  $('login').hidden = true;
  $('app').hidden = false;
  connect();
}

function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/operator`);
  socket.onopen = () => {
    $('connection').textContent = 'サーバー接続済み';
    $('connection').className = 'badge';
    clearInterval(heartbeat);
    heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 30_000);
  };
  socket.onmessage = (event) => { state = JSON.parse(event.data); render(); };
  socket.onclose = () => {
    clearInterval(heartbeat);
    $('connection').textContent = '通信切断・操作不可';
    $('connection').className = 'badge offline';
    disable();
    setTimeout(connect, 2000);
  };
}

function playerNames(ticket) {
  if (Array.isArray(ticket.playerNicknames) && ticket.playerNicknames.length) return ticket.playerNicknames;
  return Array.from({length: ticket.partySize}, (_, index) => ticket.partySize === 1 ? ticket.nickname : `${ticket.nickname}${index + 1}`);
}

function renderTimeline() {
  const visible = state.rounds
    .filter((round) => !['COMPLETED', 'CANCELED'].includes(round.status) && round.tickets.length)
    .sort((a, b) => a.number - b.number)
    .slice(0, 5);
  $('queueTimeline').replaceChildren(...visible.map((round, index) => timelineRound(round, index)));
  if (!visible.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '待機中の整理券はありません。受付QRコードから登録されると、ここに15分単位で自動配置されます。';
    $('queueTimeline').append(empty);
  }
  const playing = visible.find((round) => round.status === 'PLAYING');
  const called = visible.find((round) => round.status === 'CALLED');
  const next = visible.find((round) => scheduledRoundStates.has(round.status));
  if (playing) $('nextAction').textContent = `現在は第${playing.number}枠を体験中です。ゲーム運営画面で終了すると、この枠が完了して次枠を自動で呼び出します。`;
  else if (called?.checkedInPeople === called?.assignedPeople) $('nextAction').textContent = `第${called.number}枠は全員入場済みです。ゲーム運営画面でゲームを開始してください。`;
  else if (called) $('nextAction').textContent = `第${called.number}枠を呼び出し中です。現在${called.checkedInPeople}/${called.assignedPeople}名が入場済みです。残りのQRを確認してください。`;
  else if (next) $('nextAction').textContent = `次は第${next.number}枠です。「① 次の4名を呼び出す」から入口へ案内してください。`;
  else $('nextAction').textContent = '現在、待機中の来場者はいません。';
}

function timelineRound(round, index) {
  const article = document.createElement('article');
  article.className = `timeline-round ${round.status.toLowerCase()}`;
  const marker = document.createElement('span');
  marker.className = 'timeline-marker';
  marker.textContent = round.status === 'PLAYING' ? 'NOW・体験中' : round.status === 'CALLED' ? 'NOW・呼出中' : index === 0 ? 'NEXT' : `${index * 15}分後`;
  const heading = document.createElement('div');
  heading.className = 'timeline-heading';
  const title = document.createElement('strong');
  title.textContent = `第${round.number}枠`;
  const time = document.createElement('span');
  time.textContent = `${formatTime(round.scheduledAt)}ごろ`;
  heading.append(title, time);
  const seats = document.createElement('div');
  seats.className = 'seat-grid';
  const assignedNames = round.tickets.flatMap((ticket) => playerNames(ticket).map((name) => ({name, ticketNumber: ticket.ticketNumber, status: ticket.status})));
  for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
    const seat = document.createElement('div');
    const player = assignedNames[seatIndex];
    seat.className = `seat ${player ? (round.status === 'PLAYING' ? 'playing' : player.status === 'CHECKED_IN' ? 'checked' : round.status === 'CALLED' ? 'called' : 'assigned') : 'empty'}`;
    const strong = document.createElement('strong');
    strong.textContent = player?.name ?? '空席';
    const small = document.createElement('small');
    small.textContent = player ? `${player.status === 'CHECKED_IN' ? '入場済・' : ''}${player.ticketNumber}` : '自動充当';
    seat.append(strong, small);
    seats.append(seat);
  }
  const footer = document.createElement('p');
  footer.className = 'timeline-footer';
  footer.textContent = `${labels[round.status] || round.status}・${round.assignedPeople}/4名${round.status === 'CALLED' ? `・${round.checkedInPeople}名入場済` : ''}`;
  article.append(marker, heading, seats, footer);
  return article;
}

function render() {
  const waiting = state.tickets.filter((ticket) => ['WAITING', 'ASSIGNED', 'ON_HOLD'].includes(ticket.status));
  const upcoming = state.rounds.find((round) => scheduledRoundStates.has(round.status));
  const called = state.rounds.find((round) => round.status === 'CALLED');
  const playing = state.rounds.find((round) => round.status === 'PLAYING');
  const activeTickets = state.tickets.filter((ticket) => activeTicketStates.has(ticket.status)).sort((a, b) => a.receptionNumber - b.receptionNumber);
  renderTimeline();
  $('registrationStatus').textContent = state.registrationOpen ? '受付中' : '停止中';
  $('waitingGroups').textContent = `${waiting.length}組`;
  $('waitingPeople').textContent = `${waiting.reduce((sum, ticket) => sum + ticket.partySize, 0)}人`;
  $('emptySeats').textContent = `${4 - (upcoming?.assignedPeople || 0)}席`;
  $('calledRound').textContent = called ? `第${called.number}枠` : 'なし';
  $('playingRound').textContent = playing ? `第${playing.number}枠` : 'なし';
  const waits = state.rounds.filter((round) => scheduledRoundStates.has(round.status) && round.scheduledAt).map((round) => Math.max(0, Math.ceil((round.scheduledAt - Date.now()) / 60_000)));
  $('maxWait').textContent = waits.length ? `約${Math.max(...waits)}分` : 'なし';
  $('cycle').textContent = '15分';
  const gameConnected = state.gameLastSeenAt && Date.now() - state.gameLastSeenAt < 60_000;
  $('gameConnection').textContent = gameConnected ? 'ゲーム連携中' : state.gameLastSeenAt ? 'ゲーム未同期' : 'ゲーム未受信';
  $('gameConnection').className = `badge${gameConnected ? '' : ' offline'}`;
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';
  $('messageForm').elements.message.value = state.globalMessage;
  $('settingsForm').elements.globalDelayMinutes.value = state.settings.globalDelayMinutes;
  $('settingsForm').elements.graceMinutes.value = state.settings.graceMinutes;
  $('settingsForm').elements.maxWaitingGroups.value = state.settings.maxWaitingGroups;
  $('delaySummary').textContent = state.settings.globalDelayMinutes ? `全体で＋${state.settings.globalDelayMinutes}分` : '遅延なし';
  $('rounds').replaceChildren(...state.rounds.filter((round) => scheduledRoundStates.has(round.status)).slice(0, 12).map(roundCard));
  $('tickets').replaceChildren(...activeTickets.map(ticketRow));
  $('activeTicketCount').textContent = `${activeTickets.length}組`;
  $('emptyTickets').hidden = activeTickets.length > 0;
  disable();
}

function roundCard(round) {
  const article = document.createElement('article');
  article.className = 'round';
  const title = document.createElement('h3');
  const titleText = document.createElement('span');
  titleText.textContent = `第${round.number}枠`;
  const status = document.createElement('small');
  status.textContent = labels[round.status] || round.status;
  title.append(titleText, status);
  const meta = document.createElement('p');
  meta.textContent = `${round.assignedPeople}/4名・${formatTime(round.scheduledAt)}ごろ`;
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.value = round.scheduledAt ? new Date(round.scheduledAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
  const change = document.createElement('button');
  change.textContent = 'この枠の時刻を変更';
  change.onclick = guarded(async () => {
    const reason = prompt('変更理由を入力してください');
    if (reason === null) return;
    await action('round_time', {roundId: round.id, value: new Date(input.value).getTime(), reason});
  });
  article.append(title, meta, input, change);
  return article;
}

function ticketRow(ticket) {
  const row = document.createElement('tr');
  const round = state.rounds.find((item) => item.id === ticket.roundId);
  const values = [ticket.receptionNumber, ticket.ticketNumber, playerNames(ticket).join(' / '), `${ticket.partySize}名`, labels[ticket.status] || ticket.status, round ? `${formatTime(round.scheduledAt)}ごろ` : '未定'];
  for (const value of values) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.append(cell);
  }
  const cell = document.createElement('td');
  const button = document.createElement('button');
  button.textContent = 'この整理券を操作';
  button.onclick = () => {
    selectedTicket = ticket;
    $('dialogTitle').textContent = `${ticket.ticketNumber} ${playerNames(ticket).join('・')}`;
    $('ticketReason').value = '';
    $('ticketRound').replaceChildren(...state.rounds.filter((item) => scheduledRoundStates.has(item.status) && item.id !== ticket.roundId && item.assignedPeople + ticket.partySize <= 4).map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `第${item.number}枠（空席${4 - item.assignedPeople}）`;
      return option;
    }));
    $('ticketDialog').showModal();
  };
  cell.append(button);
  row.append(cell);
  return row;
}

function disable() {
  const locked = !socket || socket.readyState !== WebSocket.OPEN || state?.owner !== sessionId;
  document.querySelectorAll('#app button').forEach((button) => { button.disabled = locked; });
  const activeRound = state?.rounds.some((round) => ['CALLED', 'PLAYING'].includes(round.status));
  $('callNext').disabled = locked || activeRound;
  $('takeover').disabled = !socket || socket.readyState !== WebSocket.OPEN;
}

function currentSettings(delayMinutes) {
  const form = $('settingsForm');
  return {cycleMinutes: 15, autoCall: true, globalDelayMinutes: delayMinutes ?? Number(form.elements.globalDelayMinutes.value), graceMinutes: Number(form.elements.graceMinutes.value), maxWaitingGroups: Number(form.elements.maxWaitingGroups.value)};
}

$('takeover').onclick = guarded(async () => { if (confirm('この端末に操作権を移しますか？')) await post('/api/operator/takeover', {}); });
$('openRegistration').onclick = guarded(() => action('registration', {value: true}));
$('closeRegistration').onclick = guarded(() => action('registration', {value: false}));
$('callNext').onclick = guarded(async () => { if (confirm('待機列の先頭にある次枠を呼び出しますか？')) await action('call_next'); });
$('messageForm').onsubmit = guarded(() => action('global_message', {value: $('messageForm').elements.message.value}));
$('settingsForm').onsubmit = guarded(() => action('settings', {value: currentSettings()}));
$('delayMinus5').onclick = guarded(() => action('settings', {value: currentSettings(Math.max(0, state.settings.globalDelayMinutes - 5))}));
$('delayPlus5').onclick = guarded(() => action('settings', {value: currentSettings(Math.min(600, state.settings.globalDelayMinutes + 5))}));
$('applyTicketAction').onclick = guarded(async (event) => {
  event.preventDefault();
  const actionName = $('ticketAction').value;
  const text = $('ticketReason').value;
  await action(actionName, {ticketId: selectedTicket.id, roundId: actionName === 'move_round' ? $('ticketRound').value : undefined, reason: actionName === 'message' ? '' : text, value: actionName === 'message' ? text : undefined});
  $('ticketDialog').close();
});

enter().catch(() => {});
