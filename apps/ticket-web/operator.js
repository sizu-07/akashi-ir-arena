const $ = (id) => document.getElementById(id);
const labels = {
  WAITING: '待機', ASSIGNED: '割当済', CALLED: '呼出中', CHECKED_IN: '入場済', PLAYING: '体験中',
  COMPLETED: '終了', ON_HOLD: '保留', NO_SHOW: 'スキップ済み', CANCELED: '取消', EXPIRED: '失効',
  SCHEDULED: '予定', LOCKED_SCHEDULED: '時刻固定', SKIPPED: '未実施で終了', EMPTY: '空き枠', DELAYED_EMPTY: '調整・使用なし',
};
const activeTicketStates = new Set(['WAITING', 'ASSIGNED', 'CALLED', 'CHECKED_IN', 'PLAYING', 'ON_HOLD', 'NO_SHOW']);
const scheduledRoundStates = new Set(['SCHEDULED', 'LOCKED_SCHEDULED']);
const groupColors = ['#2f6fbb', '#b85c38', '#6d5aad', '#27856a'];
const groupColor = (ticket) => groupColors[[...ticket.ticketNumber].reduce((sum, character) => sum + character.charCodeAt(0), 0) % groupColors.length];
const commandId = () => `${Date.now()}-${crypto.randomUUID()}`;
const SLOT_MS = 15 * 60_000;
const floorSlotBoundary = (value) => Math.floor(value / SLOT_MS) * SLOT_MS;
const nextSlotBoundary = (value) => (Math.floor(value / SLOT_MS) + 1) * SLOT_MS;
const formatTime = (value) => value ? new Date(value).toLocaleTimeString('ja-JP', {hour: '2-digit', minute: '2-digit'}) : '時刻計算中';
const effectiveStart = (round) => round.effectiveSlotStartAt ?? round.slotStartAt ?? null;
const effectiveEnd = (round) => round.effectiveSlotEndAt ?? (effectiveStart(round) ? effectiveStart(round) + SLOT_MS : null);
const formatSlot = (round) => effectiveStart(round) && effectiveEnd(round) ? `${formatTime(effectiveStart(round))}〜${formatTime(effectiveEnd(round))}` : '時刻計算中';
let csrf = '';
let sessionId = '';
let state;
let socket;
let heartbeat;
let selectedTicket;
let globalMessageDirty = false;
let settingsDirty = false;
const actionLabels = {
  hold: '保留にする', release: '保留を解除する', cancel: '整理券を取り消す', skip_group: 'この登録グループをスキップする',
  recall_group: 'スキップを取り消して呼び戻す', move_round: '予定枠を変更する', undo_checkin: '入場処理を取り消す', message: '個別メッセージを変更する',
};
const reasonRequiredActions = new Set(['hold', 'cancel', 'skip_group', 'recall_group', 'move_round', 'undo_checkin']);

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
  showMessage(result.operation?.notice || `操作を反映しました（${result.commandId}）`, true);
  return result;
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

function futureTimelineSlots(minimumCount = 6) {
  const real = state.rounds
    .filter((round) => ['CALLED', 'PLAYING', 'SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status) && (round.tickets.length || ['CALLED', 'PLAYING'].includes(round.status)))
    .sort((a, b) => effectiveStart(a) - effectiveStart(b));
  const now = Date.now();
  const currentBoundary = floorSlotBoundary(now);
  const playing = real.find((round) => round.status === 'PLAYING');
  const called = real.find((round) => round.status === 'CALLED');
  const candidates = real.flatMap((round) => [round.slotStartAt, effectiveStart(round)]).filter((value) => value >= currentBoundary);
  const start = playing
    ? effectiveStart(playing)
    : called
      ? Math.min(called.slotStartAt ?? effectiveStart(called), effectiveStart(called))
      : real.length ? Math.min(nextSlotBoundary(now), ...candidates) : state.settings.delayAnchorAt ?? nextSlotBoundary(now);
  const lastReal = real.reduce((latest, round) => Math.max(latest, effectiveStart(round) || 0), 0);
  const end = Math.max(start + (minimumCount - 1) * SLOT_MS, lastReal + 2 * SLOT_MS);
  const byStart = new Map(real.map((round) => [effectiveStart(round), round]));
  const delaySlots = Math.floor((state.settings.globalDelayMinutes || 0) / 15);
  const slots = [];
  for (let at = start; at <= end; at += SLOT_MS) {
    const round = byStart.get(at);
    if (round) { slots.push(round); continue; }
    const blockedByShift = real.some((item) => item.slotStartAt <= at && at < effectiveStart(item));
    const blockedWithoutTickets = !real.length && at < start + delaySlots * SLOT_MS;
    const status = blockedByShift || blockedWithoutTickets ? 'DELAYED_EMPTY' : 'EMPTY';
    slots.push({id: `virtual-${at}`, number: null, status, tickets: [], skippedTickets: [], assignedPeople: 0, checkedInPeople: 0, skippedPeople: 0, effectiveSlotStartAt: at, effectiveSlotEndAt: at + SLOT_MS});
  }
  return slots;
}

function renderTimeline() {
  const visible = futureTimelineSlots().slice(0, 6);
  const timeline = $('queueTimeline');
  const signature = JSON.stringify(visible.map((round) => [round.id, round.status, effectiveStart(round), round.checkedInPeople, round.tickets.map((ticket) => [ticket.id, ticket.status])]));
  if (timeline.dataset.signature !== signature) {
    timeline.dataset.signature = signature;
    timeline.replaceChildren(...visible.map((round, index) => timelineRound(round, index)));
    timeline.scrollLeft = 0;
    requestAnimationFrame(() => { timeline.scrollLeft = 0; });
  }
  const playing = visible.find((round) => round.status === 'PLAYING');
  const called = visible.find((round) => round.status === 'CALLED');
  const calledIndex = called ? visible.indexOf(called) : -1;
  const delayedBeforeCalled = calledIndex > 0 ? visible.slice(0, calledIndex).filter((round) => round.status === 'DELAYED_EMPTY').length : 0;
  const next = state.rounds.filter((round) => scheduledRoundStates.has(round.status)).sort((a, b) => a.number - b.number)[0];
  const nextIndex = next ? visible.findIndex((round) => round.id === next.id) : -1;
  const delayedBeforeNext = nextIndex > 0 ? visible.slice(0, nextIndex).filter((round) => round.status === 'DELAYED_EMPTY').length : 0;
  if (playing && called && delayedBeforeCalled) $('nextAction').textContent = `第${playing.number}枠を体験中です。第${called.number}枠は呼出中ですが、間に${delayedBeforeCalled}枠の調整枠が入り、その後に実施します。`;
  else if (playing && called) $('nextAction').textContent = `第${playing.number}枠を体験中です。同時に次の第${called.number}枠を呼び出し中で、${called.checkedInPeople}/${called.assignedPeople}名が入場済みです。`;
  else if (playing?.pausedAt) $('nextAction').textContent = `第${playing.number}枠はゲーム一時停止中です。ゲーム運営画面から再開または終了してください。`;
  else if (playing) $('nextAction').textContent = `現在は第${playing.number}枠を体験中です。ゲーム運営画面で終了すると、この枠が完了して次枠を自動で呼び出します。`;
  else if (called && delayedBeforeCalled) $('nextAction').textContent = `第${called.number}枠は呼出中ですが、先頭に${delayedBeforeCalled}枠の調整枠が入りました。来場者へ案内を送信済みです。`;
  else if (called && called.checkedInPeople === called.assignedPeople) $('nextAction').textContent = `第${called.number}枠は全員入場済みです。ゲーム運営画面でゲームを開始してください。`;
  else if (called) $('nextAction').textContent = `第${called.number}枠を呼び出し中です。現在${called.checkedInPeople}/${called.assignedPeople}名が入場済みです。残りのQRを確認してください。`;
  else if (next && delayedBeforeNext) $('nextAction').textContent = `先頭に${delayedBeforeNext}枠の調整枠があります。第${next.number}枠は${formatTime(next.callAt)}ごろに改めて呼び出します。`;
  else if (next?.callAt > Date.now()) $('nextAction').textContent = `次は第${next.number}枠です。開始15分前の${formatTime(next.callAt)}ごろに自動で呼び出します。`;
  else if (next) $('nextAction').textContent = `次は第${next.number}枠です。「① 次の4名を呼び出す」から入口へ案内してください。`;
  else $('nextAction').textContent = '現在、待機中の来場者はいません。';
}

function renderAllRounds() {
  const history = state.rounds.filter((round) => !['CALLED', 'PLAYING', 'SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)).sort((a, b) => a.number - b.number);
  const rounds = [...history, ...futureTimelineSlots()];
  $('allRounds').replaceChildren(...rounds.map((round, index) => timelineRound(round, index, {history: true})));
  $('allRoundCount').textContent = `${rounds.length}枠`;
  $('emptyRounds').hidden = true;
}

function renderRoundControls() {
  const called = state.rounds.find((round) => round.status === 'CALLED');
  const playing = state.rounds.find((round) => round.status === 'PLAYING');
  const skipped = state.tickets.filter((ticket) => ticket.status === 'NO_SHOW').sort((a, b) => a.receptionNumber - b.receptionNumber);
  $('calledRoundControls').hidden = !called;
  if (called) {
    $('calledRoundControlTitle').textContent = `第${called.number}枠を呼び出し中`;
    $('calledRoundControlHint').textContent = '来場しない登録グループだけをスキップします。空席には後続の入れるグループを自動で補完します。';
    $('calledGroups').replaceChildren(...called.tickets.map((ticket) => {
      const item = document.createElement('div');
      item.className = 'called-group';
      item.style.setProperty('--group-color', groupColor(ticket));
      const description = document.createElement('span');
      description.textContent = `${ticket.ticketNumber}・${ticket.partySize}人組：${playerNames(ticket).join('・')}`;
      item.append(description);
      if (ticket.status === 'CALLED') {
        const button = document.createElement('button');
        button.className = 'danger';
        button.textContent = 'この組をスキップ';
        button.onclick = guarded(async () => {
          const reason = prompt(`${ticket.ticketNumber}（${ticket.partySize}人組）をスキップする理由を入力してください`, '呼出後も来場がないため');
          if (!reason?.trim()) return;
          if (confirm(`${ticket.ticketNumber}のグループだけを来場なしにします。よろしいですか？`)) await action('skip_group', {ticketId: ticket.id, reason});
        });
        item.append(button);
      } else {
        const status = document.createElement('strong');
        status.textContent = labels[ticket.status] || ticket.status;
        item.append(status);
      }
      return item;
    }));
  } else {
    $('calledGroups').replaceChildren();
  }
  $('skippedGroupControls').hidden = !skipped.length;
  $('skippedGroups').replaceChildren(...skipped.map((ticket) => {
    const item = document.createElement('div');
    item.className = 'called-group';
    item.style.setProperty('--group-color', groupColor(ticket));
    const sourceRound = state.rounds.find((round) => round.id === ticket.roundId);
    const description = document.createElement('span');
    description.textContent = `${ticket.ticketNumber}・${ticket.partySize}人組：${playerNames(ticket).join('・')}${sourceRound ? `（元の第${sourceRound.number}枠）` : ''}`;
    const button = document.createElement('button');
    button.className = 'warning recall-group';
    button.textContent = 'この組を呼び戻す';
    button.onclick = guarded(async () => {
      const reason = prompt(`${ticket.ticketNumber}（${ticket.partySize}人組）を呼び戻す理由を入力してください`, '来場を確認したため');
      if (!reason?.trim()) return;
      if (confirm(`${ticket.ticketNumber}のスキップを取り消して呼び戻します。よろしいですか？`)) await action('recall_group', {ticketId: ticket.id, reason});
    });
    item.append(description, button);
    return item;
  }));
}

function timelineRound(round, index, {history = false} = {}) {
  const ready = round.status === 'CALLED' && round.assignedPeople > 0 && round.checkedInPeople === round.assignedPeople;
  const checkingIn = round.status === 'CALLED' && round.checkedInPeople > 0 && !ready;
  const article = document.createElement('article');
  article.className = `timeline-round ${round.status.toLowerCase()}${ready ? ' ready' : ''}`;
  if (round.status === 'CALLED' && state.rounds.some((item) => item.status === 'PLAYING')) article.classList.add('called-after-playing');
  const marker = document.createElement('span');
  marker.className = 'timeline-marker';
  if (ready) marker.textContent = 'NOW・全員入場済み';
  else if (checkingIn) marker.textContent = `NOW・入場中 ${round.checkedInPeople}/${round.assignedPeople}`;
  else if (round.status === 'PLAYING' && round.pausedAt) marker.textContent = 'NOW・一時停止中';
  else if (round.status === 'PLAYING') marker.textContent = 'NOW・体験中';
  else if (round.status === 'CALLED' && effectiveStart(round) > round.slotStartAt) marker.textContent = '呼出中・調整後';
  else if (round.status === 'CALLED') marker.textContent = 'NOW・呼出中';
  else if (history || ['EMPTY', 'DELAYED_EMPTY'].includes(round.status)) marker.textContent = labels[round.status] || round.status;
  else marker.textContent = index === 0 ? 'NEXT' : `${index * 15}分後`;
  const heading = document.createElement('div');
  heading.className = 'timeline-heading';
  const title = document.createElement('strong');
  title.textContent = round.number ? `第${round.number}枠` : round.status === 'DELAYED_EMPTY' ? '調整枠' : '空き枠';
  const time = document.createElement('span');
  time.textContent = formatSlot(round);
  heading.append(title, time);
  const seats = document.createElement('div');
  seats.className = 'seat-grid';
  const groups = document.createElement('div');
  groups.className = 'round-groups';
  for (const ticket of round.tickets) {
    const chip = document.createElement('span');
    chip.className = 'group-chip';
    chip.style.setProperty('--group-color', groupColor(ticket));
    chip.textContent = `${ticket.ticketNumber}・${ticket.partySize}人組`;
    groups.append(chip);
  }
  for (const ticket of round.skippedTickets ?? []) {
    const chip = document.createElement('span');
    chip.className = 'group-chip skipped-group';
    chip.style.setProperty('--group-color', groupColor(ticket));
    chip.textContent = `${ticket.ticketNumber}・スキップ`;
    groups.append(chip);
  }
  const seatTickets = history && round.status === 'SKIPPED' && !round.tickets.length ? (round.skippedTickets ?? []) : round.tickets;
  const assignedNames = seatTickets.flatMap((ticket) => playerNames(ticket).map((name) => ({name, ticketNumber: ticket.ticketNumber, status: ticket.status, groupColor: groupColor(ticket)})));
  for (let seatIndex = 0; seatIndex < 4; seatIndex += 1) {
    const seat = document.createElement('div');
    const player = assignedNames[seatIndex];
    const seatStatus = !player ? 'empty'
      : round.status === 'COMPLETED' || player.status === 'COMPLETED' ? 'completed'
        : round.status === 'SKIPPED' || player.status === 'NO_SHOW' ? 'skipped'
          : round.status === 'PLAYING' ? 'playing'
            : player.status === 'CHECKED_IN' ? 'checked'
              : round.status === 'CALLED' ? 'called' : 'assigned';
    seat.className = `seat ${seatStatus}`;
    const strong = document.createElement('strong');
    strong.textContent = player?.name ?? '空席';
    const small = document.createElement('small');
    const ticketStateText = player?.status === 'CHECKED_IN' ? '入場済・'
      : player?.status === 'COMPLETED' ? '終了・'
        : player?.status === 'NO_SHOW' ? 'スキップ済み・' : '';
    small.textContent = player ? `${ticketStateText}${player.ticketNumber}` : ['EMPTY', 'DELAYED_EMPTY'].includes(round.status) ? '未割当' : '自動充当';
    if (player) {
      seat.classList.add('group-seat');
      seat.style.setProperty('--group-color', player.groupColor);
    }
    seat.append(strong, small);
    seats.append(seat);
  }
  const footer = document.createElement('p');
  footer.className = 'timeline-footer';
  const displayedStatus = ready ? '全員入場済み' : checkingIn ? '入場受付中' : round.status === 'PLAYING' && round.pausedAt ? '一時停止中' : labels[round.status] || round.status;
  const displayedPeople = round.status === 'SKIPPED' ? round.skippedPeople : round.assignedPeople;
  footer.textContent = round.status === 'DELAYED_EMPTY' ? '運営調整のため使用しません。終了時刻に自動で進みます'
    : round.status === 'EMPTY' ? '登録が入ると自動配置されます'
      : `${displayedStatus}・${displayedPeople}/4名${round.status === 'CALLED' ? `・${round.checkedInPeople}名入場済` : ''}`;
  article.append(marker, heading, groups, seats, footer);
  return article;
}

function render() {
  const waiting = state.tickets.filter((ticket) => ['WAITING', 'ASSIGNED'].includes(ticket.status));
  const upcoming = state.rounds.find((round) => scheduledRoundStates.has(round.status));
  const called = state.rounds.find((round) => round.status === 'CALLED');
  const playing = state.rounds.find((round) => round.status === 'PLAYING');
  const activeTickets = state.tickets.filter((ticket) => activeTicketStates.has(ticket.status)).sort((a, b) => a.receptionNumber - b.receptionNumber);
  renderTimeline();
  renderRoundControls();
  renderAllRounds();
  $('registrationStatus').textContent = state.registrationOpen ? '受付中' : '停止中';
  $('compactRegistrationStatus').textContent = state.registrationOpen ? '受付中' : '受付停止中';
  $('compactRegistrationStatus').className = `badge registration-compact ${state.registrationOpen ? 'open' : 'closed'}`;
  $('registrationBanner').className = `registration-banner ${state.registrationOpen ? 'open' : 'closed'}`;
  $('registrationBannerTitle').textContent = state.registrationOpen ? '受付中' : '受付停止中';
  $('registrationBannerHint').textContent = state.registrationOpen ? '来場者は整理券を登録できます' : '来場者は新しい整理券を登録できません';
  $('waitingGroups').textContent = `${waiting.length}組`;
  $('waitingPeople').textContent = `${waiting.reduce((sum, ticket) => sum + ticket.partySize, 0)}人`;
  $('emptySeats').textContent = `${4 - (upcoming?.assignedPeople || 0)}席`;
  $('calledRound').textContent = called ? `第${called.number}枠` : 'なし';
  $('playingRound').textContent = playing ? `第${playing.number}枠${playing.pausedAt ? '（一時停止）' : ''}` : 'なし';
  const waits = state.rounds.filter((round) => scheduledRoundStates.has(round.status) && round.callAt).map((round) => Math.max(0, Math.ceil((round.callAt - Date.now()) / 60_000)));
  $('maxWait').textContent = waits.length ? `約${Math.max(...waits)}分` : 'なし';
  $('cycle').textContent = '15分';
  const gameConnected = state.gameLastSeenAt && Date.now() - state.gameLastSeenAt < 60_000;
  $('gameConnection').textContent = gameConnected ? 'ゲーム連携中' : state.gameLastSeenAt ? 'ゲーム未同期' : 'ゲーム未受信';
  $('gameConnection').className = `badge${gameConnected ? '' : ' offline'}`;
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';
  if (!globalMessageDirty) $('messageForm').elements.message.value = state.globalMessage;
  if (!settingsDirty) {
    $('settingsForm').elements.globalDelaySlots.value = Math.floor(state.settings.globalDelayMinutes / 15);
    $('settingsForm').elements.graceMinutes.value = state.settings.graceMinutes;
    $('settingsForm').elements.maxWaitingGroups.value = state.settings.maxWaitingGroups;
  }
  const delaySlots = Math.floor(state.settings.globalDelayMinutes / 15);
  $('delaySummary').textContent = delaySlots ? `調整中：残り${delaySlots}枠（${delaySlots * 15}分）` : '調整枠なし';
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
  meta.textContent = `${round.assignedPeople}/4名・体験 ${formatSlot(round)}・入場 ${formatTime(round.callAt)}ごろ`;
  const input = document.createElement('input');
  input.type = 'datetime-local';
  input.step = '900';
  input.value = round.slotStartAt ? new Date(round.slotStartAt - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '';
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
  const admission = ticket.status === 'NO_SHOW' ? (round ? `元・第${round.number}枠` : 'スキップ済み')
    : ticket.status === 'ON_HOLD' ? '保留中'
      : ['CALLED', 'CHECKED_IN', 'PLAYING'].includes(ticket.status) && round ? `第${round.number}枠`
        : round ? `${formatTime(round.callAt)}ごろ` : '未定';
  const values = [ticket.receptionNumber, ticket.ticketNumber, playerNames(ticket).join(' / '), `${ticket.partySize}名`, labels[ticket.status] || ticket.status, admission];
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
    $('dialogStatus').textContent = `現在の状態：${labels[ticket.status] || ticket.status}・${ticket.partySize}名`;
    $('ticketDialogMessage').textContent = '';
    $('ticketReason').value = '';
    const targetRounds = state.rounds.filter((item) => scheduledRoundStates.has(item.status) && item.id !== ticket.roundId && item.assignedPeople + ticket.partySize <= 4);
    $('ticketRound').replaceChildren(...targetRounds.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = `第${item.number}枠（空席${4 - item.assignedPeople}）`;
      return option;
    }));
    const actionsByStatus = {
      WAITING: ['hold', 'cancel', 'message'],
      ASSIGNED: ['hold', ...(targetRounds.length ? ['move_round'] : []), 'cancel', 'message'],
      CALLED: ['skip_group', 'hold', 'cancel', 'message'],
      CHECKED_IN: ['undo_checkin', 'message'],
      PLAYING: ['message'],
      ON_HOLD: ['release', 'cancel', 'message'],
      NO_SHOW: ['recall_group', 'message'],
    };
    $('ticketAction').replaceChildren(...(actionsByStatus[ticket.status] ?? ['message']).map((name) => {
      const option = document.createElement('option');
      option.value = name;
      option.textContent = actionLabels[name];
      return option;
    }));
    updateTicketActionForm();
    $('ticketDialog').showModal();
  };
  cell.append(button);
  row.append(cell);
  return row;
}

function updateTicketActionForm() {
  const actionName = $('ticketAction').value;
  $('ticketRoundField').hidden = actionName !== 'move_round';
  $('ticketReasonLabel').textContent = actionName === 'message' ? '個別メッセージ' : reasonRequiredActions.has(actionName) ? '理由（必須）' : '理由（任意）';
  $('ticketReason').required = reasonRequiredActions.has(actionName);
  $('ticketReason').placeholder = actionName === 'message' ? '来場者画面へ表示する内容' : 'この操作を行う理由';
  $('ticketDialogMessage').textContent = '';
}

function disable() {
  const locked = !socket || socket.readyState !== WebSocket.OPEN || state?.owner !== sessionId;
  document.querySelectorAll('#app button').forEach((button) => { button.disabled = locked; });
  const called = state?.rounds.find((round) => round.status === 'CALLED');
  const upcoming = state?.rounds.filter((round) => scheduledRoundStates.has(round.status)).sort((a, b) => a.number - b.number)[0];
  const callIsDue = upcoming?.callAt && upcoming.callAt <= Date.now();
  $('callNext').disabled = locked || Boolean(called) || !upcoming || !callIsDue;
  document.querySelectorAll('.recall-group').forEach((button) => { button.disabled = locked; });
  $('openRegistration').disabled = locked || Boolean(state?.registrationOpen);
  $('closeRegistration').disabled = locked || !state?.registrationOpen;
  $('takeover').disabled = !socket || socket.readyState !== WebSocket.OPEN;
}

function currentSettings(delaySlots) {
  const form = $('settingsForm');
  return {cycleMinutes: 15, autoCall: true, globalDelaySlots: delaySlots ?? Number(form.elements.globalDelaySlots.value), graceMinutes: Number(form.elements.graceMinutes.value), maxWaitingGroups: Number(form.elements.maxWaitingGroups.value)};
}

function delayNotice(delaySlots) {
  if (delaySlots > 0) return `現在、運営調整のため${delaySlots}枠（${delaySlots * 15}分）遅れています。調整枠は時間の経過に合わせて自動で消化されます。今後の状況により、入場予定時刻が変更される場合があります。`;
  return '運営調整は終了しました。整理券画面の最新の入場予定時刻をご確認ください。';
}

async function applyDelaySlots(delaySlots) {
  await action('settings', {value: currentSettings(delaySlots)});
  const notice = delayNotice(delaySlots);
  await action('global_message', {value: notice});
  $('messageForm').elements.message.value = notice;
  settingsDirty = false;
  globalMessageDirty = false;
}

$('takeover').onclick = guarded(async () => { if (confirm('この端末に操作権を移しますか？')) await post('/api/operator/takeover', {}); });
$('openRegistration').onclick = guarded(() => action('registration', {value: true}));
$('closeRegistration').onclick = guarded(() => action('registration', {value: false}));
$('callNext').onclick = guarded(async () => { if (confirm('待機列の先頭にある次枠を呼び出しますか？')) await action('call_next'); });
$('messageForm').elements.message.addEventListener('input', () => { globalMessageDirty = true; });
$('settingsForm').addEventListener('input', () => { settingsDirty = true; });
$('messageForm').onsubmit = guarded(async () => { await action('global_message', {value: $('messageForm').elements.message.value}); globalMessageDirty = false; });
$('settingsForm').onsubmit = guarded(async () => {
  const delaySlots = Number($('settingsForm').elements.globalDelaySlots.value);
  const currentDelaySlots = Math.floor(state.settings.globalDelayMinutes / 15);
  if (delaySlots !== currentDelaySlots) await applyDelaySlots(delaySlots);
  else { await action('settings', {value: currentSettings()}); settingsDirty = false; }
});
$('delayMinusSlot').onclick = guarded(() => applyDelaySlots(Math.max(0, Math.floor(state.settings.globalDelayMinutes / 15) - 1)));
$('delayPlusSlot').onclick = guarded(() => applyDelaySlots(Math.min(40, Math.floor(state.settings.globalDelayMinutes / 15) + 1)));
$('delayReset').onclick = guarded(() => applyDelaySlots(0));
$('ticketAction').onchange = updateTicketActionForm;
$('ticketDialogClose').onclick = () => $('ticketDialog').close();
$('applyTicketAction').onclick = async (event) => {
  event.preventDefault();
  $('ticketDialogMessage').textContent = '';
  const actionName = $('ticketAction').value;
  const text = $('ticketReason').value;
  if (reasonRequiredActions.has(actionName) && !text.trim()) {
    $('ticketDialogMessage').textContent = '理由を入力してください。';
    $('ticketReason').focus();
    return;
  }
  try {
    await action(actionName, {ticketId: selectedTicket.id, roundId: actionName === 'move_round' ? $('ticketRound').value : undefined, reason: actionName === 'message' ? '' : text, value: actionName === 'message' ? text : undefined});
    $('ticketDialog').close();
  } catch (error) {
    $('ticketDialogMessage').textContent = error.message;
  }
};

enter().catch(() => {});
