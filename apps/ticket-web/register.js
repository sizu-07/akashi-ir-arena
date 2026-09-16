const form = document.querySelector('#registerForm');
const message = document.querySelector('#message');
const saved = localStorage.getItem('akashi-ticket-url');
const requestId = sessionStorage.getItem('akashi-registration-request') || crypto.randomUUID();
sessionStorage.setItem('akashi-registration-request', requestId);
const partySize = form.elements.partySize;
const nicknameFields = document.querySelector('#nicknameFields');
function renderNicknameFields() {
  const previous = [...nicknameFields.querySelectorAll('input')].map((input) => input.value);
  const count = Number(partySize.value);
  nicknameFields.replaceChildren(...Array.from({length: count}, (_, index) => {
    const label = document.createElement('label');
    label.textContent = `${index + 1}人目`;
    const input = document.createElement('input');
    input.name = 'nickname'; input.required = true; input.maxLength = 20; input.autocomplete = 'off';
    input.placeholder = index === 0 ? '例：あかし' : `例：プレイヤー${index + 1}`;
    input.value = previous[index] ?? '';
    label.append(input);
    return label;
  }));
}
partySize.addEventListener('change', renderNicknameFields);
renderNicknameFields();
if (saved) {
  const link = document.createElement('a');
  link.href = saved;
  link.textContent = '保存済みの整理券を開く';
  form.before(link);
}
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  message.textContent = '';
  const button = form.querySelector('button');
  button.disabled = true;
  try {
    const data = new FormData(form);
    const response = await fetch('/api/public/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId, nicknames: data.getAll('nickname'), partySize: Number(data.get('partySize')), consent: data.get('consent') === 'on'})});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
