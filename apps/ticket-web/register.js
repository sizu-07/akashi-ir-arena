const form = document.querySelector('#registerForm');
const message = document.querySelector('#message');
const saved = localStorage.getItem('akashi-ticket-url');
const requestId = sessionStorage.getItem('akashi-registration-request') || crypto.randomUUID();
sessionStorage.setItem('akashi-registration-request', requestId);
const partySize = form.elements.partySize;
const nicknameFields = document.querySelector('#nicknameFields');
const noticeDialog = document.querySelector('#mandatoryNotice');
const noticeConfirmed = document.querySelector('#noticeConfirmed');
const noticeContinue = document.querySelector('#noticeContinue');
const arrivalTime = document.querySelector('#arrivalTime');
const arrivalMessage = document.querySelector('#arrivalMessage');
const changeArrival = document.querySelector('#changeArrival');
const arrivalOptions = document.querySelector('#arrivalOptions');
const arrivalSelect = document.querySelector('#arrivalSelect');
const registerButton = document.querySelector('#registerButton');
let availability = null;
let availabilityRequest = 0;
let submitting = false;
let reviewing = false;
let reviewedData = null;
const closedScreen=document.querySelector('#closedScreen');
function setRegistrationState(registration) {
  // 枠が埋まっただけのときは受付終了の全画面にせず、入場時間の欄で知らせる。
  const closed=registration?.open===false&&registration.code!=='full';
  document.body.classList.toggle('is-closed',closed);
  closedScreen.hidden=!closed;
  if(closed){
    if(noticeDialog.open)noticeDialog.close();
    document.querySelector('#closedTitle').textContent=registration.code==='ended'?'本日の受付は終了しました':registration.code==='before_open'?'受付開始前です':'整理券受付';
    document.querySelector('#closedMessage').textContent=registration.message;
  }else if(!noticeConfirmed.checked&&!noticeDialog.open)noticeDialog.showModal();
}
noticeDialog.addEventListener('cancel', (event) => event.preventDefault());
noticeConfirmed.addEventListener('change', () => { noticeContinue.disabled = !noticeConfirmed.checked; });
noticeContinue.addEventListener('click', () => {
  if (!noticeConfirmed.checked) return;
  noticeDialog.close();
  partySize.focus();
});
noticeDialog.showModal();
const formatTime = (value) => {
  const date = new Date(value);
  const time = date.toLocaleTimeString('ja-JP', {hour: '2-digit', minute: '2-digit'});
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString('ja-JP', {month: 'numeric', day: 'numeric', weekday: 'short'})} ${time}`;
};
function showArrival() {
  if (!availability) return;
  const selected = availability.alternatives.find((option) => String(option.earliestCallAt) === arrivalSelect.value);
  const estimatedCallAt = selected?.estimatedCallAt ?? availability.current.estimatedCallAt;
  arrivalTime.textContent = `${formatTime(estimatedCallAt)}ごろ${estimatedCallAt <= Date.now() + 60_000 ? '（まもなく）' : ''}`;
  arrivalMessage.textContent = selected
    ? '選択した時間にご案内する予定です。'
    : 'この時間が難しい場合は、下のボタンから変更してください。';
}
async function refreshAvailability() {
  if (submitting || reviewing) return;
  const sequence = ++availabilityRequest;
  const previous = arrivalSelect.value;
  registerButton.disabled = true;
  arrivalTime.textContent = '確認中…';
  try {
    const response = await fetch(`/api/public/availability?partySize=${encodeURIComponent(partySize.value)}`, {cache: 'no-store'});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '案内時刻を確認できません');
    if (sequence !== availabilityRequest) return;
    setRegistrationState(result.registration);
    if(result.registration?.open===false){
      availability=null;registerButton.disabled=true;changeArrival.hidden=true;arrivalOptions.hidden=true;
      changeArrival.setAttribute('aria-expanded','false');changeArrival.textContent='この時間が難しい場合は変更する';
      if(result.registration.code==='full'){arrivalTime.textContent='空きがありません';arrivalMessage.textContent=result.registration.message;}
      return;
    }
    availability = result;
    arrivalSelect.replaceChildren();
    arrivalSelect.add(new Option(`表示中の入場時間（${formatTime(result.current.estimatedCallAt)}ごろ）`, ''));
    for (const option of result.alternatives) {
      arrivalSelect.add(new Option(`${formatTime(option.estimatedCallAt)}ごろ`, String(option.earliestCallAt)));
    }
    if ([...arrivalSelect.options].some((option) => option.value === previous)) arrivalSelect.value = previous;
    else if (previous) message.textContent = '選択した時間が更新されました。入場時間を確認してください。';
    changeArrival.hidden = result.alternatives.length === 0;
    registerButton.disabled = submitting;
    showArrival();
  } catch (error) {
    if (sequence !== availabilityRequest) return;
    availability = null;
    arrivalTime.textContent = '案内時刻を取得できません';
    changeArrival.hidden = true;
    message.textContent = error.message;
  }
}
function renderNicknameFields() {
  const previous = [...nicknameFields.querySelectorAll('input')].map((input) => input.value);
  const count = Number(partySize.value);
  nicknameFields.replaceChildren(...Array.from({length: count}, (_, index) => {
    const row = document.createElement('div');
    row.className = 'participant-row';
    const label = document.createElement('label');
    label.textContent = `${index + 1}人目`;
    const input = document.createElement('input');
    input.name = 'nickname'; input.required = true; input.maxLength = 20; input.autocomplete = 'off';
    input.placeholder = index === 0 ? '例：あかし' : `例：プレイヤー${index + 1}`;
    input.value = previous[index] ?? '';
    label.append(input);
    row.append(label);
    return row;
  }));
}
partySize.addEventListener('change', () => {
  renderNicknameFields();
  arrivalSelect.value = '';
  refreshAvailability();
});
renderNicknameFields();
refreshAvailability();
setInterval(refreshAvailability, 30_000);
changeArrival.addEventListener('click', () => {
  arrivalOptions.hidden = !arrivalOptions.hidden;
  changeArrival.setAttribute('aria-expanded', String(!arrivalOptions.hidden));
  changeArrival.textContent = arrivalOptions.hidden ? 'この時間が難しい場合は変更する' : '入場時間の一覧を閉じる';
});
arrivalSelect.addEventListener('change', showArrival);
if (saved) {
  const link = document.createElement('a');
  link.href = saved;
  link.textContent = '保存済みの整理券を開く';
  link.className = 'saved-ticket';
  form.before(link);
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  message.textContent = '';
  if (!availability || submitting || reviewing) return;
  const data = new FormData(form);
  const selected = availability.alternatives.find((option) => String(option.earliestCallAt) === arrivalSelect.value);
  const time = selected ?? availability.current;
  if (!time?.estimatedCallAt || !time?.slotStartAt || !time?.slotEndAt) {
    message.textContent = '案内時刻を確認できません。もう一度お試しください。';
    return;
  }
  reviewedData = {
    requestId,
    nicknames: data.getAll('nickname'),
    partySize: Number(data.get('partySize')),
    consent: data.get('consent') === 'on',
    earliestCallAt: arrivalSelect.value ? Number(arrivalSelect.value) : null,
    expectedSlotStartAt: time.slotStartAt,
  };
  // 確認画面は出さず、そのまま登録して整理券画面へ進む。
  submitRegistration(reviewedData);
});
async function submitRegistration(data) {
  if (!data || submitting) return;
  submitting = true;
  reviewing = true;
  registerButton.disabled = true;
  registerButton.textContent = '登録しています…';
  try {
    const response = await fetch('/api/public/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(data)});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    sessionStorage.removeItem('akashi-registration-request');
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    submitting = false;
    reviewing = false;
    reviewedData = null;
    registerButton.textContent = '確認して登録する';
    registerButton.disabled = false;
    refreshAvailability();
  }
}
