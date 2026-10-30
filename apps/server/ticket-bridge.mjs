import {existsSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export function createTicketBridge({url, apiKey, dataDir, initialRoundId = null, initialPhase = null, log = () => {}} = {}) {
  if (!url || !apiKey) return {enabled: false, connected: false, pending: 0, currentRoundId: null, observe() {}, async loadPlayerNicknames() { return []; }, async previewPlayerNicknames() { return {names: ['player1', 'player2', 'player3', 'player4'], ready: false, roundId: null, checkedInPeople: 0, assignedPeople: 0}; }, async close() {}};
  const endpoint = `${String(url).replace(/\/$/, '')}/api/game/events`;
  const currentRoundEndpoint = `${String(url).replace(/\/$/, '')}/api/game/current-round`;
  const heartbeatEndpoint = `${String(url).replace(/\/$/, '')}/api/game/heartbeat`;
  const file = path.join(dataDir, 'ticket-outbox.json');
  let outbox = [];
  let sending = false;
  let sendTask = null;
  let connected = false;
  let previousPhase = initialPhase;
  let currentRoundId = initialRoundId;
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
      return false;
    }
    outbox.push({eventId: randomUUID(), gameId: game.id, targetRoundId: currentRoundId, type, occurredAt: Date.now(), source: 'local-game-server', retryNumber: 0});
    persist();
    void flush();
    return true;
  };
  const flush = () => {
    if (sending) return sendTask;
    if (!outbox.length) return Promise.resolve();
    sending = true;
    sendTask = (async () => { try {
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
    } finally { sending = false; sendTask = null; } })();
    return sendTask;
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
  const placeholders = ['player1', 'player2', 'player3', 'player4'];
  const fetchCurrentRound = async () => {
    const response = await fetch(currentRoundEndpoint, {headers: {Authorization: `Bearer ${apiKey}`}, signal: AbortSignal.timeout(5000)});
    if (response.status === 404) return null;
    if (!response.ok) throw Error(`整理券サーバー HTTP ${response.status}`);
    return response.json();
  };
  return {
    enabled: true,
    get connected() { return connected; },
    get pending() { return outbox.length; },
    get currentRoundId() { return currentRoundId; },
    async loadPlayerNicknames() {
      const result = await fetchCurrentRound();
      if (!result) throw Error('整理券運営画面で次の4名を先に呼び出してください');
      if (result.ready === false) throw Error(`整理券の4名登録・入場確認が完了していません（${result.checkedInPeople}/${result.assignedPeople}名）`);
      // スキップ枠や運営が名前を入れた席は運営が入るため、参加者として数える。
      if (result.assignedPeople !== undefined && result.assignedPeople + (result.staffSeats ?? result.skippedPeople ?? 0) !== 4) throw Error(`整理券の参加者が4名揃っていません（現在${result.assignedPeople}名）`);
      if (!Array.isArray(result.playerNicknames) || result.playerNicknames.length !== 4) throw Error('整理券の参加者名が4名分ありません');
      currentRoundId = result.roundId;
      connected = true;
      return Array.isArray(result.playerNicknames) ? result.playerNicknames.slice(0, 4) : [];
    },
    async previewPlayerNicknames() {
      const result = await fetchCurrentRound();
      connected = true;
      if (!result) return {names: [...placeholders], ready: false, roundId: null, checkedInPeople: 0, assignedPeople: 0};
      const admitted = Array.isArray(result.admittedPlayerNicknames) ? result.admittedPlayerNicknames
        : result.ready ? result.playerNicknames : [];
      const names = placeholders.map((fallback, index) => typeof admitted?.[index] === 'string' && admitted[index].trim() ? admitted[index] : fallback);
      if (result.ready) currentRoundId = result.roundId;
      return {names, ready: result.ready === true, roundId: result.roundId, checkedInPeople: result.checkedInPeople ?? 0, assignedPeople: result.assignedPeople ?? 0};
    },
    observe(game) {
      const phase = game.phase;
      if (previousPhase === null) { previousPhase = phase; return; }
      if (phase === previousPhase) return;
      if (game.testMode) { previousPhase = phase; return; }
      if (phase === 'ACTIVE') {
        if (!game.ticketStarted) game.ticketStarted = enqueue('GAME_STARTED', game);
        else if (game.ticketPaused && enqueue('GAME_RESUMED', game)) game.ticketPaused = false;
      } else if (phase === 'PAUSED' && ['ACTIVE', 'COUNTDOWN'].includes(previousPhase) && game.ticketStarted && !game.ticketPaused) game.ticketPaused = enqueue('GAME_PAUSED', game);
      else if (phase === 'FINISHED' && previousPhase !== 'FINISHED') {
        if (!game.ticketStarted) game.ticketStarted = enqueue('GAME_STARTED', game);
        enqueue('GAME_ENDED', game);
      }
      previousPhase = phase;
    },
    async close() { clearInterval(timer); await flush(); },
  };
}
