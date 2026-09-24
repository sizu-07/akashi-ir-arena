const form = document.querySelector('#registerForm');
const message = document.querySelector('#message');
const saved = localStorage.getItem('akashi-ticket-url');
const requestId = sessionStorage.getItem('akashi-registration-request') || crypto.randomUUID();
sessionStorage.setItem('akashi-registration-request', requestId);
const partySize = form.elements.partySize;
const nicknameFields = document.querySelector('#nicknameFields');
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
    const response = await fetch('/api/public/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId, nicknames: data.getAll('nickname'), playerTeams: teams, partySize: Number(data.get('partySize')), consent: data.get('consent') === 'on'})});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    sessionStorage.removeItem('akashi-registration-request');
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
