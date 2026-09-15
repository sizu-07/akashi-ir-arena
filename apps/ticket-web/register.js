const form = document.querySelector('#registerForm');
const message = document.querySelector('#message');
const saved = localStorage.getItem('akashi-ticket-url');
const requestId = sessionStorage.getItem('akashi-registration-request') || crypto.randomUUID();
sessionStorage.setItem('akashi-registration-request', requestId);
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
    const response = await fetch('/api/public/register', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({requestId, nickname: data.get('nickname'), partySize: Number(data.get('partySize')), consent: data.get('consent') === 'on'})});
    const result = await response.json();
    if (!response.ok) throw Error(result.error || '登録できませんでした');
    localStorage.setItem('akashi-ticket-url', result.ticketUrl);
    location.href = result.ticketUrl;
  } catch (error) {
    message.textContent = error.message;
    button.disabled = false;
  }
});
