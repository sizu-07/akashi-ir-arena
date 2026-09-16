import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const csvOf = (rows) => {
  const cell = (value) => `"${String(value ?? '').replace(/^[=+@-]/, "'$&").replaceAll('"', '""')}"`;
  return `\uFEFF${[
    ['日時', '種別', '操作者', '理由', '整理券ID', '回ID', '変更内容'].map(cell).join(','),
    ...rows.map((row) => [new Date(row.at).toISOString(), row.type, row.operator, row.reason, row.ticketId, row.roundId, JSON.stringify(row.details ?? {})].map(cell).join(',')),
  ].join('\r\n')}`;
};

export function ticketStorage(dir) {
  mkdirSync(dir, {recursive: true});
  const snapshot = path.join(dir, 'tickets.json');
  const events = path.join(dir, 'ticket-events.jsonl');

  return {
    load() {
      if (!existsSync(snapshot)) return null;
      return JSON.parse(readFileSync(snapshot, 'utf8'));
    },
    save(state) {
      const temporary = `${snapshot}.tmp`;
      writeFileSync(temporary, JSON.stringify(state, null, 2));
      renameSync(temporary, snapshot);
    },
    log(event) {
      appendFileSync(events, `${JSON.stringify(event)}\n`);
    },
    async flush() {},
    csv() {
      const rows = existsSync(events)
        ? readFileSync(events, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
        : [];
      return csvOf(rows);
    },
  };
}

export function supabaseTicketStorage({url, secretKey, serviceRoleKey}) {
  const apiKey = secretKey || serviceRoleKey;
  if (!/^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$)/.test(url ?? '') || !apiKey) throw Error('SupabaseのURLとサーバー用APIキーを確認してください');
  const base = `${url.replace(/\/$/, '')}/rest/v1`;
  const headers = {'Content-Type': 'application/json', apikey: apiKey};
  // New sb_secret_* keys are API keys, not JWTs. Only the legacy service_role
  // key belongs in an Authorization Bearer header.
  if (!secretKey && serviceRoleKey) headers.Authorization = `Bearer ${serviceRoleKey}`;
  let pending = Promise.resolve();
  const query = async (pathname, options = {}) => {
    const response = await fetch(`${base}${pathname}`, {...options, headers: {...headers, ...options.headers}, signal: AbortSignal.timeout(10_000)});
    if (!response.ok) throw Error(`Supabase ${response.status}: ${(await response.text()).slice(0, 300)}`);
    if (response.status === 204) return null;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  };
  const enqueue = (operation) => { pending = pending.catch(() => {}).then(operation); };
  return {
    async load() {
      const rows = await query('/ticket_state?select=data&id=eq.main&limit=1');
      return rows[0]?.data ?? null;
    },
    save(state) {
      const data = structuredClone(state);
      enqueue(() => query('/ticket_state?on_conflict=id', {method: 'POST', headers: {Prefer: 'resolution=merge-duplicates,return=minimal'}, body: JSON.stringify({id: 'main', data, updated_at: new Date().toISOString()})}));
    },
    log(event) {
      const payload = structuredClone(event);
      enqueue(() => query('/ticket_events', {method: 'POST', headers: {Prefer: 'return=minimal'}, body: JSON.stringify({id: payload.id, occurred_at: new Date(payload.at).toISOString(), payload})}));
    },
    async flush() { await pending; },
    async csv() {
      await pending;
      const rows = await query('/ticket_events?select=payload&order=occurred_at.asc&limit=10000');
      return csvOf(rows.map((row) => row.payload));
    },
  };
}
