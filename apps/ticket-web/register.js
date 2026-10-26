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
const timeSelection = document.querySelector('#timeSelection');
const recommendedTime = document.querySelector('#recommendedTime');
const availableSlots = document.querySelector('#availableSlots');
const changeTime = document.querySelector('#changeTime');
const toReview = document.querySelector('#toReview');
const backToForm = document.querySelector('#backToForm');
const review = document.querySelector('#registrationReview');
const reviewBack = document.querySelector('#reviewBack');
const reviewSubmit = document.querySelector('#reviewSubmit');
let pendingRegistration = null;
let selectedSlot = null;
let submitting = false;

noticeDialog.addEventListener('cancel', (event) => event.preventDefault());
noticeConfirmed.addEventListener('change', () => { noticeContinue.disabled = !noticeConfirmed.checked; });
noticeContinue.addEventListener('click', () => {
  if (!noticeConfirmed.checked) return;
  noticeDialog.close();
  partySize.focus();
});
noticeDialog.showModal();

const formatDate = (value) => new Intl.DateTimeFormat('ja-JP', {month: 'numeric', day: 'numeric', weekday: 'short'}).format(new Date(value));
const formatTime = (value) => new Intl.DateTimeFormat('ja-JP', {hour: '2-digit', minute: '2-digit', hour12: false}).format(new Date(value));
const formatSlot = (slot) => `${formatDate(slot.startAt)} ${formatTime(slot.startAt)}〜${formatTime(slot.endAt)}`;
const formatAdmission = (slot) => {
  const callAt = Math.max(slot.startAt - 15 * 60_000, Date.now());
  return `${formatDate(callAt)} ${formatTime(callAt)}ごろ`;
};
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
partySize.addEventListener('change', renderNicknameFields);
renderNicknameFields();
if (saved) {
  const link = document.createElement('a');
  link.href = saved;
  link.textContent = '保存済みの整理券を開く';
  link.className = 'saved-ticket';
  form.before(link);
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const data = new FormData(form);
    pendingRegistration = {requestId, nicknames: data.getAll('nickname'), partySize: Number(data.get('partySize')), consent: data.get('consent') === 'on'};
    const response = await fetch(`/api/public/available-slots?partySize=${pendingRegistration.partySize}`);
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録可能な時間を取得できませんでした');
    renderAvailableSlots(result.slots);
    form.hidden = true;
    timeSelection.hidden = false;
    timeSelection.scrollIntoView({behavior: 'smooth', block: 'start'});
  } catch (error) {
    message.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

function renderAvailableSlots(slots) {
  if (!slots.length) throw Error('現在、この人数で登録できる時間がありません');
  selectedSlot = slots[0];
  availableSlots.hidden = true;
  changeTime.setAttribute('aria-expanded', 'false');
  changeTime.textContent = 'この時間が難しい場合は変更する';
  renderSelectedTime();
  availableSlots.replaceChildren(...slots.map((slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'slot-choice';
    const time = document.createElement('strong');
    time.textContent = `${formatAdmission(slot)} 入場`;
    const meta = document.createElement('span');
    meta.textContent = `ゲームプレイ予定 ${formatSlot(slot)}・残り${slot.remainingSeats}名`;
    button.append(time, meta);
    button.addEventListener('click', () => {
      selectedSlot = slot;
      renderSelectedTime();
      availableSlots.hidden = true;
      changeTime.setAttribute('aria-expanded', 'false');
      changeTime.textContent = 'この時間が難しい場合は変更する';
    });
    return button;
  }));
}

function renderSelectedTime() {
  recommendedTime.replaceChildren();
  const label = document.createElement('span');
  label.textContent = '入場時間はこの時間です';
  const strong = document.createElement('strong');
  strong.textContent = formatAdmission(selectedSlot);
  const guidance = document.createElement('span');
  guidance.textContent = `ゲームプレイ予定 ${formatSlot(selectedSlot)}。この時間が難しい場合は下のボタンを押してください。`;
  recommendedTime.append(label, strong, guidance);
}

changeTime.addEventListener('click', () => {
  availableSlots.hidden = !availableSlots.hidden;
  changeTime.setAttribute('aria-expanded', String(!availableSlots.hidden));
  changeTime.textContent = availableSlots.hidden ? 'この時間が難しい場合は変更する' : '時間一覧を閉じる';
});

toReview.addEventListener('click', () => {
  if (!pendingRegistration || !selectedSlot) return;
  document.querySelector('#reviewPartySize').textContent = `${pendingRegistration.partySize}人`;
  document.querySelector('#reviewNicknames').textContent = pendingRegistration.nicknames.join('・');
  document.querySelector('#reviewArrival').textContent = formatAdmission(selectedSlot);
  document.querySelector('#reviewPlayWindow').textContent = `${formatTime(selectedSlot.startAt)}〜${formatTime(selectedSlot.endAt)}`;
  document.querySelector('#reviewEnd').textContent = `終了予定 ${formatDate(selectedSlot.endAt)} ${formatTime(selectedSlot.endAt)}ごろ`;
  timeSelection.hidden = true;
  review.hidden = false;
  review.scrollIntoView({block: 'start'});
});

reviewBack.addEventListener('click', () => {
  review.hidden = true;
  timeSelection.hidden = false;
  message.textContent = '';
});

reviewSubmit.addEventListener('click', async () => {
  if (!pendingRegistration || !selectedSlot || submitting) return;
  message.textContent = '';
  submitting = true;
  reviewSubmit.disabled = true;
  try {
    const response = await fetch('/api/public/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...pendingRegistration, preferredSlotStartAt: selectedSlot.startAt}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    sessionStorage.removeItem('akashi-registration-request');
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    review.hidden = true;
    timeSelection.hidden = false;
    try {
      const response = await fetch(`/api/public/available-slots?partySize=${pendingRegistration.partySize}`);
      const result = await response.json();
      if (response.ok) renderAvailableSlots(result.slots);
    } catch {}
  } finally {
    submitting = false;
    reviewSubmit.disabled = false;
  }
});

backToForm.addEventListener('click', () => {
  timeSelection.hidden = true;
  form.hidden = false;
  pendingRegistration = null;
  message.textContent = '';
  form.scrollIntoView({behavior: 'smooth', block: 'start'});
});
