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
const backToForm = document.querySelector('#backToForm');
let pendingRegistration = null;

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
function updateTeamOptions() {
  const selects = [...nicknameFields.querySelectorAll('select[name="team"]')];
  const counts = {A: 0, B: 0};
  for (const select of selects) if (select.value) counts[select.value] += 1;
  for (const select of selects) {
    for (const team of ['A', 'B']) {
      select.querySelector(`option[value="${team}"]`).disabled = counts[team] >= 2 && select.value !== team;
    }
  }
}
function renderNicknameFields() {
  const previous = [...nicknameFields.querySelectorAll('input')].map((input) => input.value);
  const previousTeams = [...nicknameFields.querySelectorAll('select')].map((select) => select.value);
  const count = Number(partySize.value);
  document.querySelector('#teamHint').hidden = count < 3;
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
    if (count >= 3) {
      const teamLabel = document.createElement('label');
      teamLabel.textContent = `${index + 1}人目のチーム`;
      const select = document.createElement('select');
      select.name = 'team';
      select.required = true;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'チームを選択';
      select.append(placeholder);
      for (const team of ['A', 'B']) {
        const option = document.createElement('option');
        option.value = team;
        option.textContent = `チーム${team}`;
        select.append(option);
      }
      select.value = previousTeams[index] ?? '';
      teamLabel.append(select);
      row.append(teamLabel);
    }
    return row;
  }));
  updateTeamOptions();
}
partySize.addEventListener('change', renderNicknameFields);
nicknameFields.addEventListener('change', (event) => {
  if (event.target.matches('select[name="team"]')) updateTeamOptions();
});
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
    const teams = data.getAll('team');
    if (teams.length && (teams.filter((team) => team === 'A').length > 2 || teams.filter((team) => team === 'B').length > 2)) throw Error('各チームは2人までです。チームを選び直してください');
    pendingRegistration = {requestId, nicknames: data.getAll('nickname'), playerTeams: teams, partySize: Number(data.get('partySize')), consent: data.get('consent') === 'on'};
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
  recommendedTime.innerHTML = '';
  const label = document.createElement('span');
  label.textContent = 'おすすめ';
  const strong = document.createElement('strong');
  strong.textContent = `ゲーム時間は ${formatSlot(slots[0])} です。`;
  const guidance = document.createElement('span');
  guidance.textContent = 'この時間が難しい場合は、下から別の時間を選んでください。';
  recommendedTime.append(label, strong, guidance);
  availableSlots.replaceChildren(...slots.map((slot) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `slot-choice${slot.recommended ? ' recommended' : ''}`;
    const time = document.createElement('strong');
    time.textContent = formatSlot(slot);
    const meta = document.createElement('span');
    meta.textContent = `${slot.recommended ? 'おすすめ・' : ''}残り${slot.remainingSeats}名`;
    button.append(time, meta);
    button.addEventListener('click', () => confirmRegistration(slot.startAt));
    return button;
  }));
}

async function confirmRegistration(preferredSlotStartAt) {
  message.textContent = '';
  const buttons = [...availableSlots.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  try {
    const response = await fetch('/api/public/register', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({...pendingRegistration, preferredSlotStartAt}),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    sessionStorage.removeItem('akashi-registration-request');
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    try {
      const response = await fetch(`/api/public/available-slots?partySize=${pendingRegistration.partySize}`);
      const result = await response.json();
      if (response.ok) renderAvailableSlots(result.slots);
    } catch {}
    for (const button of buttons) button.disabled = false;
  }
}

backToForm.addEventListener('click', () => {
  timeSelection.hidden = true;
  form.hidden = false;
  pendingRegistration = null;
  message.textContent = '';
  form.scrollIntoView({behavior: 'smooth', block: 'start'});
});
