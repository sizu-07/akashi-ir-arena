const token = location.hash.slice(1);
const $ = (id) => document.getElementById(id);
const states = {WAITING:'受付済み',ASSIGNED:'予定回に割当済み',CALLED:'呼び出し中',CHECKED_IN:'入場確認済み',PLAYING:'体験中',COMPLETED:'体験終了',ON_HOLD:'保留中',NO_SHOW:'呼出終了（スキップ済み）',CANCELED:'キャンセル済み',EXPIRED:'期限切れ'};
let socket;
let pollTimer;
let heartbeat;
let hasData = false;
const terminal = new Set(['COMPLETED','NO_SHOW','CANCELED','EXPIRED']);
function render(ticket) {
  hasData = true;
  $('content').hidden = false;
  $('ticketNumber').textContent = ticket.ticketNumber;
  $('status').textContent = states[ticket.status] || ticket.status;
  $('status').className = `status ${ticket.status}`;
  $('identity').textContent = `${(ticket.playerNicknames || [ticket.nickname]).join('・')} / ${ticket.partySize}名`;
  $('called').hidden = ticket.status !== 'CALLED';
  $('groups').textContent = `${ticket.groupsAhead}組・${ticket.peopleAhead}人`;
  $('wait').textContent = ticket.waitMinutes === null ? '計算中' : `約${ticket.waitMinutes}分`;
  $('estimate').textContent = ticket.estimatedCallAt ? `${new Date(ticket.estimatedCallAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}ごろ` : '計算中';
  const time = (value) => new Date(value).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'});
  $('slotWindow').textContent = ticket.slotStartAt && ticket.slotEndAt ? `体験時間の目安：${time(ticket.slotStartAt)}〜${time(ticket.slotEndAt)}` : '';
  $('messages').hidden = !ticket.globalMessage && !ticket.personalMessage;
  $('globalMessage').textContent = ticket.globalMessage;
  $('personalMessage').textContent = ticket.personalMessage ? `あなたへの連絡：${ticket.personalMessage}` : '';
  $('qrCard').hidden = terminal.has(ticket.status);
  $('qr').src = `/api/public/qr/${encodeURIComponent(token)}`;
  $('cancel').hidden = !['WAITING','ASSIGNED'].includes(ticket.status);
  $('updated').textContent = `最終更新：${new Date(ticket.updatedAt).toLocaleTimeString('ja-JP')}`;
}
async function fetchTicket() {
  try {
    const response = await fetch(`/api/public/ticket/${encodeURIComponent(token)}`, {cache:'no-store'});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '整理券を取得できません');
    render(result);
  } catch (error) { $('error').textContent = error.message; }
}
function connected(value) {
  $('connection').textContent = value ? 'リアルタイム更新中' : '通信切断';
  $('connection').className = `badge${value ? '' : ' offline'}`;
  $('offline').hidden = value || !hasData;
}
function connect() {
  if (!token) { $('error').textContent = '整理券URLが正しくありません'; return; }
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ticket?token=${encodeURIComponent(token)}`);
  socket.onopen = () => { connected(true); clearInterval(pollTimer); clearInterval(heartbeat); heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('ping');},30_000); };
  socket.onmessage = (event) => render(JSON.parse(event.data));
  socket.onclose = () => { connected(false); clearInterval(heartbeat); clearInterval(pollTimer); pollTimer = setInterval(fetchTicket, 5000); setTimeout(connect, 4000); };
}
$('cancel').addEventListener('click', async () => {
  if (!confirm('この整理券をキャンセルしますか？元に戻せません。')) return;
  const response = await fetch(`/api/public/cancel/${encodeURIComponent(token)}`, {method:'POST'});
  const result = await response.json();
  if (!response.ok) $('error').textContent = result.error || 'キャンセルできませんでした';
});
fetchTicket(); connect();
