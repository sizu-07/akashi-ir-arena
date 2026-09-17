import http from 'node:http';
import path from 'node:path';
import {existsSync, readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {WebSocketServer, WebSocket} from 'ws';
import QRCode from 'qrcode';
import {supabaseTicketStorage, ticketStorage} from './store.mjs';
import {TicketQueue} from './tickets.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const webRoot = path.join(root, 'apps/ticket-web');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export async function createTicketApp({
  port = 0,
  bind = '127.0.0.1',
  dataDir = path.join(root, 'data/tickets'),
  operatorPassword,
  gameApiKey,
  publicOrigin = '',
  secureCookies = publicOrigin.startsWith('https://'),
  supabaseUrl = '',
  supabaseSecretKey = '',
  supabaseServiceRoleKey = '',
} = {}) {
  if (typeof operatorPassword !== 'string' || operatorPassword.length < 12) throw Error('運営パスワードは12文字以上にしてください');
  if (typeof gameApiKey !== 'string' || gameApiKey.length < 24) throw Error('ゲームAPIキーは24文字以上にしてください');
  const db = supabaseUrl ? supabaseTicketStorage({url: supabaseUrl, secretKey: supabaseSecretKey, serviceRoleKey: supabaseServiceRoleKey}) : ticketStorage(dataDir);
  const queue = new TicketQueue({saved: await db.load(), save: (state) => db.save(state), log: (event) => db.log(event)});
  const sessions = new Map();
  const attempts = new Map();
  const commands = new Map();
  let owner = null;
  const wss = new WebSocketServer({noServer: true, maxPayload: 8192});

  const json = (res, status, data) => {
    res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store'});
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    let text = '';
    for await (const chunk of req) {
      text += chunk;
      if (text.length > 32_768) throw Error('本文が大きすぎます');
    }
    return JSON.parse(text || '{}');
  };
  const cookie = (req) => (req.headers.cookie ?? '').split(';').map((item) => item.trim()).find((item) => item.startsWith('ticket_operator='))?.slice(16);
  const session = (req) => {
    const item = sessions.get(cookie(req));
    if (!item || item.expiresAt <= Date.now()) return null;
    item.seenAt = Date.now();
    return item;
  };
  const requestOrigin = (req) => publicOrigin || `${req.headers['x-forwarded-proto'] || 'http'}://${req.headers['x-forwarded-host'] || req.headers.host}`;
  const validOrigin = (req) => !req.headers.origin || req.headers.origin === requestOrigin(req) || req.headers.origin === `http://${req.headers.host}`;
  const operatorOnly = (req, res, csrf = false) => {
    const current = session(req);
    if (!current) { json(res, 401, {error: 'ログインしてください'}); return null; }
    if (csrf && !same(req.headers['x-csrf-token'], current.csrf)) { json(res, 403, {error: '再ログインしてください'}); return null; }
    return current;
  };
  const broadcast = () => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const payload = ws.role === 'operator' ? {...queue.operatorView(), owner} : queue.publicTicket(ws.accessToken);
      if (payload) ws.send(JSON.stringify(payload)); else ws.close(1008, '整理券が見つかりません');
    }
  };
  const broadcastOperators = () => {
    const payload = {...queue.operatorView(), owner};
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN && ws.role === 'operator') ws.send(JSON.stringify(payload));
  };
  const staticFiles = new Map([
    ['/register', 'register.html'], ['/ticket', 'ticket.html'], ['/operator', 'operator.html'], ['/scanner', 'scanner.html'],
    ['/ticket.css', 'ticket.css'], ['/register.js', 'register.js'], ['/ticket.js', 'ticket.js'], ['/operator.js', 'operator.js'], ['/scanner.js', 'scanner.js'],
    ['/vendor/jsqr.js', path.join(root, 'node_modules/jsqr/dist/jsQR.js')],
  ]);
  const contentTypes = {'.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8'};

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'POST' && !validOrigin(req)) return json(res, 403, {error: '別サイトからの送信は禁止されています'});
      if (url.pathname === '/health') return json(res, 200, {ok: true, updatedAt: queue.state.updatedAt});
      if (url.pathname === '/') { res.writeHead(302, {Location: '/register'}); return res.end(); }

      if (url.pathname === '/api/public/register' && req.method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        const rate = attempts.get(`register:${ip}`) ?? {count: 0, resetAt: Date.now() + 60_000};
        if (rate.resetAt < Date.now()) { rate.count = 0; rate.resetAt = Date.now() + 60_000; }
        if (++rate.count > 60) return json(res, 429, {error: '登録操作が多すぎます。1分後に再試行してください'});
        attempts.set(`register:${ip}`, rate);
        const ticket = queue.register(await body(req));
        await db.flush();
        broadcast();
        return json(res, 201, {...ticket, ticketUrl: `${requestOrigin(req)}/ticket#${ticket.accessToken}`});
      }
      if (url.pathname.startsWith('/api/public/ticket/') && req.method === 'GET') {
        const accessToken = decodeURIComponent(url.pathname.slice('/api/public/ticket/'.length));
        const ticket = queue.publicTicket(accessToken);
        return json(res, ticket ? 200 : 404, ticket ?? {error: '整理券が見つかりません'});
      }
      if (url.pathname.startsWith('/api/public/qr/') && req.method === 'GET') {
        const accessToken = decodeURIComponent(url.pathname.slice('/api/public/qr/'.length));
        const ticket = queue.publicTicket(accessToken);
        if (!ticket) return json(res, 404, {error: '整理券が見つかりません'});
        const svg = await QRCode.toString(`AKASHI:${ticket.qrToken}`, {type: 'svg', width: 360, margin: 1, errorCorrectionLevel: 'M'});
        res.writeHead(200, {'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store'});
        return res.end(svg);
      }
      if (url.pathname.startsWith('/api/public/cancel/') && req.method === 'POST') {
        queue.cancelByVisitor(decodeURIComponent(url.pathname.slice('/api/public/cancel/'.length)));
        await db.flush();
        broadcast();
        return json(res, 200, {ok: true});
      }

      if (url.pathname === '/api/operator/login' && req.method === 'POST') {
        const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
        const rate = attempts.get(`login:${ip}`) ?? {count: 0, resetAt: Date.now() + 60_000};
        if (rate.resetAt < Date.now()) { rate.count = 0; rate.resetAt = Date.now() + 60_000; }
        if (++rate.count > 8) return json(res, 429, {error: 'ログイン試行が多すぎます。1分後に再試行してください'});
        attempts.set(`login:${ip}`, rate);
        const input = await body(req);
        if (!same(input.password, operatorPassword)) return json(res, 403, {error: 'パスワードが違います'});
        const id = randomBytes(12).toString('hex');
        const key = randomBytes(32).toString('base64url');
        const current = {id, csrf: randomBytes(24).toString('base64url'), expiresAt: Date.now() + 12 * 60 * 60_000, seenAt: Date.now()};
        sessions.set(key, current);
        owner ||= id;
        attempts.delete(`login:${ip}`);
        res.setHeader('Set-Cookie', `ticket_operator=${key}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? '; Secure' : ''}`);
        return json(res, 200, {id, csrf: current.csrf, owner});
      }
      if (url.pathname === '/api/operator/session' && req.method === 'GET') {
        const current = operatorOnly(req, res);
        if (!current) return;
        return json(res, 200, {id: current.id, csrf: current.csrf, owner});
      }
      if (url.pathname === '/api/operator/state' && req.method === 'GET') {
        const current = operatorOnly(req, res);
        if (!current) return;
        return json(res, 200, {...queue.operatorView(), owner, sessionId: current.id});
      }
      if (url.pathname === '/api/operator/takeover' && req.method === 'POST') {
        const current = operatorOnly(req, res, true);
        if (!current) return;
        owner = current.id;
        queue.persist('operator_takeover', {operator: current.id});
        await db.flush();
        broadcast();
        return json(res, 200, {ok: true});
      }
      if (url.pathname === '/api/operator/action' && req.method === 'POST') {
        const current = operatorOnly(req, res, true);
        if (!current) return;
        if (owner !== current.id) return json(res, 403, {error: '閲覧専用です。操作権を取得してください'});
        const input = await body(req);
        if (typeof input.commandId !== 'string' || input.commandId.length > 100) throw Error('commandIdが必要です');
        const key = `${current.id}:${input.commandId}`;
        if (commands.has(key)) return json(res, 200, commands.get(key));
        const operation = queue.operatorAction({...input, operator: current.id});
        await db.flush();
        const result = {ok: true, commandId: input.commandId, operation: operation ?? null};
        commands.set(key, result);
        if (commands.size > 3000) commands.delete(commands.keys().next().value);
        broadcast();
        return json(res, 200, result);
      }
      if (url.pathname === '/api/operator/check-in' && req.method === 'POST') {
        const current = operatorOnly(req, res, true);
        if (!current) return;
        if (owner !== current.id) return json(res, 403, {error: '閲覧専用です。操作権を取得してください'});
        const input = await body(req);
        const raw = String(input.value ?? '');
        const qrToken = raw.startsWith('AKASHI:') ? raw.slice(7) : raw.includes('/scan/') ? raw.split('/scan/').at(-1).split(/[?#]/)[0] : raw;
        const result = queue.checkIn(qrToken, current.id);
        await db.flush();
        broadcast();
        return json(res, 200, result);
      }
      if (url.pathname === '/api/operator/export.csv' && req.method === 'GET') {
        if (!operatorOnly(req, res)) return;
        res.writeHead(200, {'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ticket-events.csv"'});
        return res.end(await db.csv());
      }
      if (url.pathname === '/api/operator/register-qr.svg' && req.method === 'GET') {
        if (!operatorOnly(req, res)) return;
        const svg = await QRCode.toString(`${requestOrigin(req)}/register`, {type: 'svg', width: 420, margin: 2, errorCorrectionLevel: 'H'});
        res.writeHead(200, {'Content-Type': 'image/svg+xml', 'Cache-Control': 'private, no-store'});
        return res.end(svg);
      }

      if (url.pathname === '/api/game/events' && req.method === 'POST') {
        if (!same(req.headers.authorization, `Bearer ${gameApiKey}`)) return json(res, 401, {error: 'APIキーが無効です'});
        const result = queue.applyGameEvent(await body(req));
        await db.flush();
        broadcast();
        return json(res, 200, {ok: true, ...result});
      }
      if (url.pathname === '/api/game/heartbeat' && req.method === 'POST') {
        if (!same(req.headers.authorization, `Bearer ${gameApiKey}`)) return json(res, 401, {error: 'APIキーが無効です'});
        queue.state.gameLastSeenAt = Date.now();
        broadcastOperators();
        return json(res, 200, {ok: true});
      }
      if (url.pathname === '/api/game/current-round' && req.method === 'GET') {
        if (!same(req.headers.authorization, `Bearer ${gameApiKey}`)) return json(res, 401, {error: 'APIキーが無効です'});
        const round = queue.state.rounds.find((item) => item.status === 'CALLED') ?? queue.state.rounds.find((item) => item.status === 'PLAYING');
        const playerNicknames = round?.ticketIds.flatMap((id) => queue.ticket(id)?.playerNicknames ?? []);
        const summary = round && queue.roundSummary(round.id);
        return json(res, round ? 200 : 404, round ? {roundId: round.id, number: round.number, status: round.status, playerNicknames, assignedPeople: summary.assignedPeople, checkedInPeople: summary.checkedInPeople, ready: summary.assignedPeople > 0 && summary.checkedInPeople === summary.assignedPeople} : {error: '対象回がありません'});
      }

      if (url.pathname.startsWith('/scan/')) { res.writeHead(302, {Location: `/scanner#${url.pathname.slice(6)}`}); return res.end(); }
      const relative = staticFiles.get(url.pathname);
      if (relative) {
        const file = path.isAbsolute(relative) ? relative : path.join(webRoot, relative);
        if (!existsSync(file)) return json(res, 404, {});
        const data = readFileSync(file);
        res.writeHead(200, {'Content-Type': contentTypes[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length, 'Cache-Control': 'no-cache'});
        return res.end(data);
      }
      return json(res, 404, {error: 'ページが見つかりません'});
    } catch (error) {
      return json(res, 400, {error: error.message});
    }
  });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (!validOrigin(req)) return socket.destroy();
    let role = null;
    let accessToken = null;
    if (url.pathname === '/ws/operator' && session(req)) role = 'operator';
    if (url.pathname === '/ws/ticket' && queue.publicTicket(url.searchParams.get('token'))) { role = 'ticket'; accessToken = url.searchParams.get('token'); }
    if (!role) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.role = role; ws.accessToken = accessToken;
      ws.on('message', () => {});
      wss.emit('connection', ws, req);
      const payload = role === 'operator' ? {...queue.operatorView(), owner} : queue.publicTicket(accessToken);
      ws.send(JSON.stringify(payload));
    });
  });

  await new Promise((resolve, reject) => {
    const cleanupListeners = () => { server.off('error', failed); server.off('listening', listening); };
    const failed = (error) => { cleanupListeners(); reject(error); };
    const listening = () => { cleanupListeners(); resolve(); };
    server.once('error', failed);
    server.once('listening', listening);
    server.listen(port, bind);
  });
  let checkingDueRound = false;
  const dueRoundTimer = setInterval(async () => {
    if (checkingDueRound) return;
    checkingDueRound = true;
    try {
      const result = queue.advanceTime('automatic-time', {requireStarted: true});
      if (result.changed) { await db.flush(); broadcast(); }
    } catch (error) {
      console.error('整理券の時刻進行:', error.message);
    } finally {
      checkingDueRound = false;
    }
  }, 1000);
  dueRoundTimer.unref();
  const cleanup = setInterval(() => {
    for (const [key, item] of sessions) if (item.expiresAt <= Date.now()) sessions.delete(key);
    for (const ws of wss.clients) if (ws.readyState === WebSocket.OPEN) ws.ping();
  }, 30_000);
  cleanup.unref();
  return {
    server,
    queue,
    async close() {
      clearInterval(dueRoundTimer);
      clearInterval(cleanup);
      const serverClosed = new Promise((resolve) => server.close(resolve));
      for (const ws of wss.clients) ws.terminate();
      await serverClosed;
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 8787);
  const operatorPassword = process.env.TICKET_OPERATOR_PASSWORD;
  const gameApiKey = process.env.TICKET_GAME_API_KEY;
  const publicOrigin = process.env.PUBLIC_ORIGIN || '';
  const dataDir = process.env.TICKET_DATA_DIR || path.join(root, 'data/tickets');
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || '';
  const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const app = await createTicketApp({port, bind: '0.0.0.0', dataDir, operatorPassword, gameApiKey, publicOrigin, supabaseUrl, supabaseSecretKey, supabaseServiceRoleKey});
  console.log(`整理券サーバー: ${publicOrigin || `http://localhost:${app.server.address().port}`} /register`);
}
