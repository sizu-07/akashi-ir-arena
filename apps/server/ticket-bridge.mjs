import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function createTicketBridge({url, apiKey, dataDir, log = () => {}} = {}) {
  if (!url || !apiKey) return {enabled: false, connected: false, pending: 0, observe() {}, async loadPlayerNicknames() { return []; }, async close() {}};
  const endpoint = `${String(url).replace(/\/$/, '')}/api/game/events`;
  const currentRoundEndpoint = `${String(url).replace(/\/$/, '')}/api/game/current-round`;
  const heartbeatEndpoint = `${String(url).replace(/\/$/, '')}/api/game/heartbeat`;
  const file = path.join(dataDir, 'ticket-outbox.json');
  let outbox = [];
  let sending = false;
  let connected = false;
  let previousPhase = null;
  let currentRoundId = null;
  let heartbeatRunning = false;
  try { if (existsSync(file)) outbox = JSON.parse(readFileSync(file, 'utf8')); } catch (error) { log({at: Date.now(), type: 'ticket_outbox_load_failed', reason: error.message}); }
  const persist = () => {
    const temporary = `${file}.tmp`;
    writeFileSync(temporary, JSON.stringify(outbox, null, 2));
    renameSync(temporary, file);
  };
  const invalidLoadedEvents = outbox.filter((event) => !event?.targetRoundId);
  if (invalidLoadedEvents.length) {
    outbox = outbox.filter((event) => event?.targetRoundId);
    persist();
    log({at: Date.now(), type: 'ticket_outbox_invalid_events_removed', count: invalidLoadedEvents.length, reason: '対象枠IDのないイベントは誤った枠へ適用されるため削除'});
  }
  const enqueue = (type, game) => {
    if (!currentRoundId) {
      log({at: Date.now(), type: 'ticket_event_not_queued', gameId: game.id, eventType: type, reason: '対象枠IDが確定していません'});
      return;
    }
    outbox.push({eventId: randomUUID(), gameId: game.id, targetRoundId: currentRoundId, type, occurredAt: Date.now(), source: 'local-game-server', retryNumber: 0});
    persist();
    void flush();
  };
  const flush = async () => {
    if (sending || !outbox.length) return;
    sending = true;
    try {
      while (outbox.length) {
        const event = outbox[0];
        event.retryNumber += 1;
        const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`}, body: JSON.stringify(event), signal: AbortSignal.timeout(5000)});
        if (!response.ok) {
          const responseText = (await response.text()).slice(0, 200);
          if ([400, 404].includes(response.status)) {
            outbox.shift();
            persist();
            log({at: Date.now(), type: 'ticket_event_rejected', eventId: event.eventId, reason: `HTTP ${response.status}: ${responseText}`});
            continue;
          }
          throw Error(`HTTP ${response.status}: ${responseText}`);
        }
        outbox.shift();
        persist();
        if (event.type === 'GAME_ENDED' && event.targetRoundId === currentRoundId) currentRoundId = null;
        connected = true;
      }
    } catch (error) {
      connected = false;
      persist();
      log({at: Date.now(), type: 'ticket_sync_failed', reason: error.message, pending: outbox.length});
    } finally { sending = false; }
  };
  const heartbeat = async () => {
    if (heartbeatRunning) return;
    heartbeatRunning = true;
    try {
      const response = await fetch(heartbeatEndpoint, {method: 'POST', headers: {Authorization: `Bearer ${apiKey}`}, signal: AbortSignal.timeout(5000)});
      connected = response.ok;
    } catch { connected = false; }
    finally { heartbeatRunning = false; }
  };
  const timer = setInterval(() => { void flush(); void heartbeat(); }, 5000);
  timer.unref();
  void heartbeat();
  return {
    enabled: true,
    get connected() { return connected; },
    get pending() { return outbox.length; },
    async loadPlayerNicknames() {
      const response = await fetch(currentRoundEndpoint, {headers: {Authorization: `Bearer ${apiKey}`}, signal: AbortSignal.timeout(5000)});
      const result = await response.json();
      if (!response.ok) throw Error(response.status === 404 ? '整理券運営画面で次の4名を先に呼び出してください' : `整理券サーバー HTTP ${response.status}`);
      if (result.ready === false) throw Error(`整理券の入場確認が完了していません（${result.checkedInPeople}/${result.assignedPeople}名）`);
      currentRoundId = result.roundId;
      connected = true;
      return Array.isArray(result.playerNicknames) ? result.playerNicknames.slice(0, 4) : [];
    },
    observe(game) {
      const phase = game.phase;
      if (previousPhase === null) { previousPhase = phase; return; }
      if (phase === previousPhase) return;
      if (phase === 'ACTIVE') enqueue(previousPhase === 'PAUSED' ? 'GAME_RESUMED' : 'GAME_STARTED', game);
      else if (phase === 'PAUSED' && ['ACTIVE', 'COUNTDOWN'].includes(previousPhase)) enqueue('GAME_PAUSED', game);
      else if (phase === 'FINISHED' && previousPhase !== 'FINISHED') enqueue('GAME_ENDED', game);
      previousPhase = phase;
    },
    async close() { clearInterval(timer); await flush(); },
  };
}
