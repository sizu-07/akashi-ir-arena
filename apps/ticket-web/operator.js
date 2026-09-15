const $ = (id) => document.getElementById(id);
const names = {WAITING:'待機',ASSIGNED:'割当済',CALLED:'呼出中',CHECKED_IN:'入場済',PLAYING:'体験中',COMPLETED:'終了',ON_HOLD:'保留',NO_SHOW:'来場なし',CANCELED:'取消',EXPIRED:'失効',SCHEDULED:'予定',LOCKED_SCHEDULED:'手動固定'};
let csrf = '';
let sessionId = '';
let state;
let socket;
let heartbeat;
let selectedTicket;
const commandId = () => `${Date.now()}-${crypto.randomUUID()}`;
const gameFromQuery = new URLSearchParams(location.search).get('game');
if (gameFromQuery && /^https?:\/\/[^/]+\/?$/.test(gameFromQuery)) localStorage.setItem('akashi-game-operator-url', gameFromQuery);
$('gameOperatorTab').href = localStorage.getItem('akashi-game-operator-url') || 'http://localhost:8080/';
const showMessage = (text, ok = false) => { $('message').textContent = text; $('message').className = ok ? 'success' : 'error'; };
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const result = await response.json();
  if (!response.ok) throw Error(result.error || '操作に失敗しました');
  return result;
}
async function post(url, data) { return request(url, {method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(data)}); }
async function action(actionName, extra = {}) { const result = await post('/api/operator/action', {action:actionName, commandId:commandId(), ...extra}); showMessage(`操作を反映しました（${result.commandId}）`, true); }
function guarded(callback) { return async (event) => { event?.preventDefault(); try { await callback(event); } catch (error) { showMessage(error.message); } }; }
$('loginForm').addEventListener('submit', guarded(async () => {
  const password = new FormData($('loginForm')).get('password');
  const result = await request('/api/operator/login', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password})});
  csrf = result.csrf; sessionId = result.id; $('loginForm').reset(); await enter();
}));
async function enter() {
  const session = await request('/api/operator/session'); csrf = session.csrf; sessionId = session.id;
  $('login').hidden = true; $('app').hidden = false; connect();
}
function connect() {
  socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/operator`);
  socket.onopen = () => { $('connection').textContent = 'サーバー接続済み'; $('connection').className = 'badge'; clearInterval(heartbeat); heartbeat=setInterval(()=>{if(socket.readyState===WebSocket.OPEN)socket.send('ping');},30_000); };
  socket.onmessage = (event) => { state = JSON.parse(event.data); render(); };
  socket.onclose = () => { clearInterval(heartbeat); $('connection').textContent = '通信切断・操作不可'; $('connection').className = 'badge offline'; disable(); setTimeout(connect, 2000); };
}
function render() {
  const active = state.tickets.filter((t) => ['WAITING','ASSIGNED','ON_HOLD'].includes(t.status));
  const next = state.rounds.find((r) => r.status === 'SCHEDULED');
  const called = state.rounds.find((r) => r.status === 'CALLED');
  const playing = state.rounds.find((r) => r.status === 'PLAYING');
  $('registrationStatus').textContent = state.registrationOpen ? '受付中' : '停止中';
  $('waitingGroups').textContent = `${active.length}組`;
  $('waitingPeople').textContent = `${active.reduce((sum,t)=>sum+t.partySize,0)}人`;
  $('emptySeats').textContent = `${4-(next?.assignedPeople||0)}席`;
  $('calledRound').textContent = called ? `第${called.number}回` : 'なし';
  $('playingRound').textContent = playing ? `第${playing.number}回` : 'なし';
  const times = state.rounds.filter(r=>r.status==='SCHEDULED'&&r.scheduledAt).map(r=>Math.max(0,Math.ceil((r.scheduledAt-Date.now())/60000)));
  $('maxWait').textContent = times.length ? `約${Math.max(...times)}分` : 'なし';
  $('cycle').textContent = `${state.settings.cycleMinutes}分`;
  $('gameConnection').textContent = state.gameLastSeenAt && Date.now()-state.gameLastSeenAt<60_000 ? '接続' : state.gameLastSeenAt ? '未同期' : '未受信';
  $('role').textContent = state.owner === sessionId ? '主操作端末' : '閲覧専用';
  $('messageForm').elements.message.value = state.globalMessage;
  for (const [key,value] of Object.entries(state.settings)) { const input=$('settingsForm').elements[key]; if(input) input.type==='checkbox' ? input.checked=value : input.value=value; }
  $('rounds').replaceChildren(...state.rounds.filter(r=>!['COMPLETED'].includes(r.status)).slice(0,12).map(roundCard));
  $('tickets').replaceChildren(...[...state.tickets].sort((a,b)=>a.receptionNumber-b.receptionNumber).map(ticketRow));
  disable();
}
function roundCard(round) {
  const article=document.createElement('article'); article.className='round';
  const title=document.createElement('h3'); title.innerHTML=`<span>第${round.number}回</span><small>${names[round.status]||round.status}</small>`;
  const meta=document.createElement('p'); meta.textContent=`${round.assignedPeople}/4名・入場確認 ${round.checkedInPeople}名${round.scheduledAt ? `\n${new Date(round.scheduledAt).toLocaleTimeString('ja-JP',{hour:'2-digit',minute:'2-digit'})}ごろ` : ''}`; meta.style.whiteSpace='pre-line';
  const list=document.createElement('ul'); for(const ticket of round.tickets){const li=document.createElement('li');li.textContent=`${ticket.ticketNumber} ${ticket.nickname}（${ticket.partySize}名）`;list.append(li);}
  const actions=document.createElement('div');actions.className='actions compact';
  if(round.status==='CALLED'){actions.append(roundButton('再呼出','recall',round.id),roundButton('ゲーム開始','start_round',round.id));}
  if(round.status==='PLAYING'){actions.append(roundButton('一時停止','pause_round',round.id),roundButton('ゲーム終了','finish_round',round.id));}
  if(['SCHEDULED','LOCKED_SCHEDULED'].includes(round.status)){
    const time=document.createElement('input');time.type='datetime-local';time.value=round.scheduledAt?new Date(round.scheduledAt-new Date().getTimezoneOffset()*60000).toISOString().slice(0,16):'';
    const change=document.createElement('button');change.textContent='予定時刻を変更';change.onclick=guarded(async()=>{const reason=prompt('変更理由を入力してください');if(reason===null)return;await action('round_time',{roundId:round.id,value:new Date(time.value).getTime(),reason});});actions.append(time,change);
  }
  article.append(title,meta,list,actions); return article;
}
function roundButton(label,actionName,roundId){const button=document.createElement('button');button.textContent=label;button.onclick=guarded(()=>action(actionName,{roundId}));return button;}
function ticketRow(ticket){const row=document.createElement('tr');const round=state.rounds.find(r=>r.id===ticket.roundId);for(const value of [ticket.receptionNumber,ticket.ticketNumber,ticket.nickname,`${ticket.partySize}名`,names[ticket.status]||ticket.status,round?`第${round.number}回`:'—',new Date(ticket.registeredAt).toLocaleTimeString('ja-JP')]){const cell=document.createElement('td');cell.textContent=value;row.append(cell);}const cell=document.createElement('td');const button=document.createElement('button');button.textContent='操作';button.onclick=()=>{selectedTicket=ticket;$('dialogTitle').textContent=`${ticket.ticketNumber} ${ticket.nickname}`;$('ticketReason').value='';$('ticketRound').replaceChildren(...state.rounds.filter(r=>['SCHEDULED','LOCKED_SCHEDULED'].includes(r.status)&&r.id!==ticket.roundId&&r.assignedPeople+ticket.partySize<=4).map(r=>{const option=document.createElement('option');option.value=r.id;option.textContent=`第${r.number}回（空席${4-r.assignedPeople}）`;return option;}));$('ticketDialog').showModal();};cell.append(button);row.append(cell);return row;}
function disable(){const locked=!socket||socket.readyState!==WebSocket.OPEN||state?.owner!==sessionId;document.querySelectorAll('#app button').forEach(b=>b.disabled=locked);$('takeover').disabled=!socket||socket.readyState!==WebSocket.OPEN;}
$('takeover').onclick=guarded(async()=>{if(confirm('この端末に操作権を移しますか？'))await post('/api/operator/takeover',{});});
$('openRegistration').onclick=guarded(()=>action('registration',{value:true}));
$('closeRegistration').onclick=guarded(()=>action('registration',{value:false}));
$('callNext').onclick=guarded(async()=>{if(confirm('次の予定回を呼び出しますか？'))await action('call_next');});
$('messageForm').onsubmit=guarded(()=>action('global_message',{value:$('messageForm').elements.message.value}));
$('settingsForm').onsubmit=guarded(()=>{const form=$('settingsForm');return action('settings',{value:{cycleMinutes:Number(form.elements.cycleMinutes.value),globalDelayMinutes:Number(form.elements.globalDelayMinutes.value),graceMinutes:Number(form.elements.graceMinutes.value),maxWaitingGroups:Number(form.elements.maxWaitingGroups.value),autoCall:form.elements.autoCall.checked}});});
$('applyTicketAction').onclick=guarded(async(event)=>{event.preventDefault();const actionName=$('ticketAction').value;const text=$('ticketReason').value;await action(actionName,{ticketId:selectedTicket.id,roundId:actionName==='move_round'?$('ticketRound').value:undefined,reason:actionName==='message'?'':text,value:actionName==='message'?text:undefined});$('ticketDialog').close();});
enter().catch(()=>{});
