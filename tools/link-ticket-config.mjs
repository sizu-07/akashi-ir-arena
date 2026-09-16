import {existsSync, readFileSync, writeFileSync} from 'node:fs';

const isLocalUrl = (value) => {
  try { return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname); }
  catch { return false; }
};

export function linkTicketConfig({gameFile = 'config/local.json', ticketFile = 'config/ticket-local.json'} = {}) {
  if (!existsSync(gameFile) || !existsSync(ticketFile)) return {linked: false, reason: 'missing'};
  const game = JSON.parse(readFileSync(gameFile, 'utf8'));
  const ticket = JSON.parse(readFileSync(ticketFile, 'utf8'));
  if (typeof ticket.gameApiKey !== 'string' || ticket.gameApiKey.length < 24) throw Error('整理券側のゲームAPIキーが不正です');
  const targetUrl = String(ticket.publicOrigin || `http://127.0.0.1:${ticket.port || 8787}`).replace(/\/$/, '');
  if (game.ticketServerUrl && !isLocalUrl(game.ticketServerUrl) && game.ticketServerUrl !== targetUrl) return {linked: false, reason: 'external', url: game.ticketServerUrl};
  const changed = game.ticketServerUrl !== targetUrl || game.ticketServerApiKey !== ticket.gameApiKey;
  game.ticketServerUrl = targetUrl;
  game.ticketServerApiKey = ticket.gameApiKey;
  if (changed) writeFileSync(gameFile, `${JSON.stringify(game, null, 2)}\n`);
  return {linked: true, changed, url: targetUrl};
}
