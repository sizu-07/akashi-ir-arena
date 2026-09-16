import {randomBytes, randomUUID} from 'node:crypto';

export const TICKET_STATES = Object.freeze([
  'WAITING', 'ASSIGNED', 'CALLED', 'CHECKED_IN', 'PLAYING', 'COMPLETED',
  'ON_HOLD', 'NO_SHOW', 'CANCELED', 'EXPIRED',
]);

const mutableStates = new Set(['WAITING', 'ASSIGNED']);
const terminalStates = new Set(['COMPLETED', 'NO_SHOW', 'CANCELED', 'EXPIRED']);
const token = () => randomBytes(24).toString('base64url');
const clone = (value) => structuredClone(value);
const SLOT_MINUTES = 15;
const legacyPlayerNames = (nickname, partySize) => Array.from({length: partySize}, (_, index) => partySize === 1 ? nickname : `${nickname}${index + 1}`);
const bestFillIndexes = (tickets, capacity) => {
  const combinations = Array.from({length: capacity + 1}, () => null);
  combinations[0] = [];
  for (const [index, ticket] of tickets.entries()) {
    for (let people = capacity - ticket.partySize; people >= 0; people -= 1) {
      if (combinations[people] && !combinations[people + ticket.partySize]) combinations[people + ticket.partySize] = [...combinations[people], index];
    }
  }
  for (let people = capacity; people >= 0; people -= 1) if (combinations[people]) return combinations[people];
  return [];
};

export class TicketQueue {
  constructor({saved = null, save = () => {}, log = () => {}, now = Date.now} = {}) {
    this.save = save;
    this.log = log;
    this.now = now;
    this.state = saved ?? {
      version: 2,
      nextReceptionNumber: 1,
      nextTicketNumber: 1,
      nextRoundNumber: 1,
      registrationOpen: true,
      globalMessage: '',
      settings: {
        cycleMinutes: SLOT_MINUTES,
        globalDelayMinutes: 0,
        graceMinutes: 3,
        maxWaitingGroups: 100,
        autoCall: true,
      },
      tickets: [],
      rounds: [],
      processedGameEvents: [],
      updatedAt: now(),
    };
    this.state.settings = {...this.state.settings, cycleMinutes: SLOT_MINUTES, autoCall: true};
    this.state.version = 2;
    for (const ticket of this.state.tickets) {
      if (!Array.isArray(ticket.playerNicknames) || ticket.playerNicknames.length !== ticket.partySize) {
        ticket.playerNicknames = legacyPlayerNames(ticket.nickname, ticket.partySize);
      }
    }
    const repair = this.normalizeActiveRounds();
    this.recalculate(false);
    if (repair) this.persist('state_repaired', {reason: '同時に進行中だった枠を1つへ正規化', details: repair});
  }

  normalizeActiveRounds() {
    const active = this.state.rounds.filter((round) => ['CALLED', 'PLAYING'].includes(round.status)).sort((a, b) => a.number - b.number);
    if (active.length <= 1) return null;
    const playing = active.find((round) => round.status === 'PLAYING');
    const checkedIn = active.find((round) => round.ticketIds.some((id) => this.ticket(id)?.status === 'CHECKED_IN'));
    const keep = playing ?? checkedIn ?? active[0];
    const first = active[0];
    if (keep.id !== first.id) [keep.number, first.number] = [first.number, keep.number];
    const resetRoundIds = [];
    for (const round of active) {
      if (round.id === keep.id) continue;
      resetRoundIds.push(round.id);
      round.status = 'SCHEDULED';
      round.calledAt = null;
      round.scheduledAt = null;
      for (const id of round.ticketIds) {
        const ticket = this.ticket(id);
        if (!ticket || !['CALLED', 'CHECKED_IN'].includes(ticket.status)) continue;
        ticket.status = 'ASSIGNED';
        ticket.calledAt = null;
        ticket.checkedInAt = null;
        ticket.updatedAt = this.now();
      }
    }
    return {keptRoundId: keep.id, resetRoundIds};
  }

  persist(type, {operator = 'system', reason = '', ticketId = null, roundId = null, details = {}} = {}) {
    this.state.updatedAt = this.now();
    const event = {id: randomUUID(), at: this.state.updatedAt, type, operator, reason, ticketId, roundId, details};
    this.log(event);
    this.save(this.state);
    return event;
  }

  register({nickname, nicknames, partySize, consent, requestId}) {
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 100) throw Error('登録要求IDが必要です');
    const existing = this.state.tickets.find((item) => item.registrationRequestId === requestId);
    if (existing) { this.save(this.state); return this.publicTicket(existing); }
    if (!this.state.registrationOpen) throw Error('現在、整理券の受付を停止しています');
    const size = Number(partySize);
    if (!Number.isInteger(size) || size < 1 || size > 4) throw Error('人数は1〜4人で入力してください');
    const legacyName = String(nickname ?? '').trim();
    const playerNames = Array.isArray(nicknames)
      ? nicknames.map((name) => String(name ?? '').trim())
      : legacyPlayerNames(legacyName, size);
    if (playerNames.length !== size) throw Error('参加人数とニックネームの数が一致しません');
    if (playerNames.some((name) => !name || name.length > 20)) throw Error('ニックネームは1人ずつ1〜20文字で入力してください');
    if (consent !== true) throw Error('注意事項への同意が必要です');
    const waiting = this.state.tickets.filter((item) => !terminalStates.has(item.status) && item.status !== 'PLAYING').length;
    if (waiting >= this.state.settings.maxWaitingGroups) throw Error('受付上限に達しました');
    const now = this.now();
    const ticket = {
      id: randomUUID(),
      registrationRequestId: requestId,
      ticketNumber: `A${String(this.state.nextTicketNumber++).padStart(3, '0')}`,
      receptionNumber: this.state.nextReceptionNumber++,
      nickname: legacyName || playerNames.join('・'),
      playerNicknames: playerNames,
      partySize: size,
      status: 'WAITING',
      accessToken: token(),
      qrToken: token(),
      roundId: null,
      personalMessage: '',
      registeredAt: now,
      calledAt: null,
      checkedInAt: null,
      updatedAt: now,
    };
    this.state.tickets.push(ticket);
    this.recalculate(false);
    this.persist('ticket_registered', {ticketId: ticket.id, details: {ticketNumber: ticket.ticketNumber, partySize: size, receptionNumber: ticket.receptionNumber}});
    return this.publicTicket(ticket);
  }

  recalculate(record = true, operator = 'system', reason = '待機列を再計算') {
    const reusableRounds = this.state.rounds.filter((round) => round.status === 'SCHEDULED').sort((a, b) => a.number - b.number);
    const lockedRoundIds = new Set(this.state.rounds.filter((round) => round.status !== 'SCHEDULED').map((round) => round.id));
    const lockedTicketIds = new Set(this.state.tickets.filter((ticket) => ticket.roundId && lockedRoundIds.has(ticket.roundId)).map((ticket) => ticket.id));
    const candidates = this.state.tickets
      .filter((ticket) => mutableStates.has(ticket.status) && !lockedTicketIds.has(ticket.id))
      .sort((a, b) => a.receptionNumber - b.receptionNumber);

    this.state.rounds = this.state.rounds.filter((round) => round.status !== 'SCHEDULED');
    for (const ticket of candidates) {
      ticket.status = 'WAITING';
      ticket.roundId = null;
    }

    const remaining = [...candidates];
    let roundIndex = 0;
    while (remaining.length) {
      const assigned = [remaining.shift()];
      const seats = 4 - assigned[0].partySize;
      const fillIndexes = bestFillIndexes(remaining, seats);
      assigned.push(...fillIndexes.map((index) => remaining[index]));
      for (const index of [...fillIndexes].reverse()) remaining.splice(index, 1);
      const round = reusableRounds[roundIndex++] ?? {
        id: randomUUID(), number: this.state.nextRoundNumber++, status: 'SCHEDULED',
        ticketIds: [], scheduledAt: null, calledAt: null, startedAt: null, completedAt: null, delayMinutes: 0,
      };
      round.ticketIds = assigned.map((ticket) => ticket.id);
      this.state.rounds.push(round);
      for (const ticket of assigned) {
        ticket.status = 'ASSIGNED';
        ticket.roundId = round.id;
        ticket.updatedAt = this.now();
      }
    }
    this.scheduleRounds();
    if (record) this.persist('queue_recalculated', {operator, reason});
  }

  scheduleRounds() {
    const active = this.state.rounds.find((round) => ['CALLED', 'PLAYING'].includes(round.status));
    let start = active?.scheduledAt ?? this.now();
    const ordered = this.state.rounds.filter((round) => !['COMPLETED', 'CANCELED'].includes(round.status)).sort((a, b) => a.number - b.number);
    for (const round of ordered) {
      if (round.status === 'PLAYING' && round.startedAt) start = round.startedAt;
      if (['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)) {
        if (round.manualScheduledAt) start = round.manualScheduledAt;
        else start += this.state.settings.cycleMinutes * 60_000;
        round.scheduledAt = round.manualScheduledAt ?? start + (this.state.settings.globalDelayMinutes + round.delayMinutes) * 60_000;
      } else if (round.scheduledAt) {
        start = round.scheduledAt;
      }
    }
  }

  publicTicket(ticketOrAccessToken) {
    const ticket = typeof ticketOrAccessToken === 'string'
      ? this.state.tickets.find((item) => item.accessToken === ticketOrAccessToken)
      : ticketOrAccessToken;
    if (!ticket) return null;
    const round = this.round(ticket.roundId);
    const ahead = this.state.tickets.filter((item) => {
      if (terminalStates.has(item.status) || item.status === 'ON_HOLD') return false;
      const itemRound = this.round(item.roundId);
      if (round && itemRound) return itemRound.number < round.number;
      return item.receptionNumber < ticket.receptionNumber;
    });
    const waitMinutes = round?.scheduledAt ? Math.max(0, Math.ceil((round.scheduledAt - this.now()) / 60_000)) : null;
    return {
      ticketNumber: ticket.ticketNumber,
      nickname: ticket.nickname,
      playerNicknames: clone(ticket.playerNicknames),
      partySize: ticket.partySize,
      status: ticket.status,
      roundNumber: round?.number ?? null,
      groupsAhead: ahead.length,
      peopleAhead: ahead.reduce((sum, item) => sum + item.partySize, 0),
      waitMinutes,
      estimatedCallAt: round?.scheduledAt ?? null,
      globalMessage: this.state.globalMessage,
      personalMessage: ticket.personalMessage,
      qrToken: ticket.qrToken,
      accessToken: ticket.accessToken,
      updatedAt: this.state.updatedAt,
    };
  }

  operatorView() {
    const tickets = this.state.tickets.map((ticket) => ({...ticket, accessToken: undefined, qrToken: undefined}));
    const rounds = this.state.rounds.sort((a, b) => a.number - b.number).map((round) => ({
      ...round,
      assignedPeople: round.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0),
      checkedInPeople: round.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.status === 'CHECKED_IN' ? this.ticket(id).partySize : 0), 0),
      tickets: round.ticketIds.map((id) => {
        const ticket = this.ticket(id);
        return ticket && {id: ticket.id, ticketNumber: ticket.ticketNumber, nickname: ticket.nickname, playerNicknames: clone(ticket.playerNicknames), partySize: ticket.partySize, status: ticket.status};
      }).filter(Boolean),
    }));
    return {registrationOpen: this.state.registrationOpen, globalMessage: this.state.globalMessage, settings: clone(this.state.settings), tickets, rounds, gameLastSeenAt: this.state.gameLastSeenAt ?? null, updatedAt: this.state.updatedAt};
  }

  ticket(id) { return this.state.tickets.find((item) => item.id === id); }
  round(id) { return this.state.rounds.find((item) => item.id === id); }

  callNext(operator) {
    const active = this.state.rounds.find((item) => ['CALLED', 'PLAYING'].includes(item.status));
    if (active) throw Error(`第${active.number}枠が${active.status === 'PLAYING' ? '体験中' : '呼出中'}です。終了してから次枠を呼び出してください`);
    const round = this.state.rounds.filter((item) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(item.status)).sort((a, b) => a.number - b.number)[0];
    if (!round) throw Error('呼び出せる予定回がありません');
    round.status = 'CALLED';
    round.calledAt = this.now();
    round.scheduledAt = round.calledAt;
    for (const id of round.ticketIds) {
      const ticket = this.ticket(id);
      ticket.status = 'CALLED'; ticket.calledAt = round.calledAt; ticket.updatedAt = round.calledAt;
    }
    this.scheduleRounds();
    this.persist('round_called', {operator, roundId: round.id, details: {number: round.number}});
    return round;
  }

  checkIn(qrToken, operator) {
    const ticket = this.state.tickets.find((item) => item.qrToken === qrToken);
    if (!ticket) return {code: 'NOT_FOUND'};
    if (['CHECKED_IN', 'PLAYING', 'COMPLETED'].includes(ticket.status)) return {code: 'ALREADY_USED', ticket: this.scanTicket(ticket)};
    if (ticket.status === 'CANCELED') return {code: 'CANCELED', ticket: this.scanTicket(ticket)};
    if (ticket.status !== 'CALLED') return {code: 'TOO_EARLY', ticket: this.scanTicket(ticket)};
    ticket.status = 'CHECKED_IN'; ticket.checkedInAt = this.now(); ticket.updatedAt = ticket.checkedInAt;
    this.persist('ticket_checked_in', {operator, ticketId: ticket.id, roundId: ticket.roundId});
    return {code: 'OK', ticket: this.scanTicket(ticket), round: this.roundSummary(ticket.roundId)};
  }

  scanTicket(ticket) {
    return {ticketNumber: ticket.ticketNumber, nickname: ticket.nickname, playerNicknames: clone(ticket.playerNicknames), partySize: ticket.partySize, status: ticket.status};
  }

  roundSummary(roundId) {
    const round = this.round(roundId);
    if (!round) return null;
    const tickets = round.ticketIds.map((id) => this.ticket(id)).filter(Boolean);
    return {number: round.number, checkedInPeople: tickets.filter((item) => item.status === 'CHECKED_IN').reduce((sum, item) => sum + item.partySize, 0), assignedPeople: tickets.reduce((sum, item) => sum + item.partySize, 0)};
  }

  cancelByVisitor(accessToken) {
    const ticket = this.state.tickets.find((item) => item.accessToken === accessToken);
    if (!ticket) throw Error('整理券が見つかりません');
    if (!mutableStates.has(ticket.status)) throw Error('この整理券は現在キャンセルできません');
    this.changeTicket(ticket, 'CANCELED', 'visitor', '来場者による取消');
  }

  operatorAction({action, ticketId, roundId, value, reason, operator}) {
    const important = new Set(['cancel', 'no_show', 'move_round', 'round_time', 'undo_checkin']);
    if (important.has(action) && !String(reason ?? '').trim()) throw Error('この操作には理由が必要です');
    const ticket = ticketId && this.ticket(ticketId);
    if (ticketId && !ticket) throw Error('整理券が見つかりません');
    switch (action) {
      case 'registration': this.state.registrationOpen = Boolean(value); this.persist('registration_changed', {operator, details: {open: Boolean(value)}}); break;
      case 'call_next': this.callNext(operator); break;
      case 'recall': {
        const round = this.round(roundId); if (!round || round.status !== 'CALLED') throw Error('呼出中の回を選んでください');
        this.persist('round_recalled', {operator, roundId}); break;
      }
      case 'hold': if (!['WAITING', 'ASSIGNED', 'CALLED'].includes(ticket.status)) throw Error('この状態の整理券は保留にできません'); this.changeTicket(ticket, 'ON_HOLD', operator, reason || '運営保留'); break;
      case 'release': if (ticket.status !== 'ON_HOLD') throw Error('保留中ではありません'); ticket.status = 'WAITING'; ticket.roundId = null; this.recalculate(false); this.persist('ticket_released', {operator, ticketId, reason}); break;
      case 'cancel': if (terminalStates.has(ticket.status) || ticket.status === 'PLAYING') throw Error('この状態の整理券は取消できません'); this.changeTicket(ticket, 'CANCELED', operator, reason); break;
      case 'no_show': if (ticket.status !== 'CALLED') throw Error('呼出中の整理券だけを来場なしにできます'); this.changeTicket(ticket, 'NO_SHOW', operator, reason); break;
      case 'return_queue': if (!['ON_HOLD', 'NO_SHOW', 'CANCELED'].includes(ticket.status)) throw Error('保留・来場なし・取消の整理券だけを待機列へ戻せます'); ticket.status = 'WAITING'; ticket.roundId = null; this.recalculate(false); this.persist('ticket_returned', {operator, ticketId, reason: reason || '待機列へ戻す'}); break;
      case 'move_round': {
        if (ticket.status !== 'ASSIGNED') throw Error('割当済みの整理券だけを変更できます');
        const before = this.round(ticket.roundId), target = this.round(roundId);
        if (!before || !target || !['SCHEDULED', 'LOCKED_SCHEDULED'].includes(target.status)) throw Error('変更先の予定回が見つかりません');
        if (before.id === target.id) throw Error('現在とは別の回を選んでください');
        const people = target.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0);
        if (people + ticket.partySize > 4) throw Error('変更先の空席が足りません');
        before.ticketIds = before.ticketIds.filter((id) => id !== ticket.id); target.ticketIds.push(ticket.id);
        before.status = 'LOCKED_SCHEDULED'; target.status = 'LOCKED_SCHEDULED'; ticket.roundId = target.id; ticket.updatedAt = this.now();
        this.persist('ticket_round_changed', {operator, reason, ticketId, roundId: target.id, details: {beforeRoundId: before.id, afterRoundId: target.id}}); break;
      }
      case 'round_time': {
        const round = this.round(roundId); const at = Number(value);
        if (!round || !['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)) throw Error('予定中の回を選んでください');
        if (!Number.isFinite(at) || at < this.now() - 60_000 || at > this.now() + 24 * 60 * 60_000) throw Error('予定時刻が範囲外です');
        const before = round.scheduledAt; round.manualScheduledAt = at; round.status = 'LOCKED_SCHEDULED'; this.scheduleRounds();
        this.persist('round_time_changed', {operator, reason, roundId, details: {before, after: at}}); break;
      }
      case 'message': ticket.personalMessage = String(value ?? '').slice(0, 300); ticket.updatedAt = this.now(); this.persist('personal_message_changed', {operator, ticketId, details: {message: ticket.personalMessage}}); break;
      case 'global_message': this.state.globalMessage = String(value ?? '').slice(0, 500); this.persist('global_message_changed', {operator, details: {message: this.state.globalMessage}}); break;
      case 'settings': this.updateSettings(value, operator); break;
      case 'undo_checkin': if (ticket.status !== 'CHECKED_IN') throw Error('入場確認済みではありません'); ticket.status = 'CALLED'; ticket.checkedInAt = null; this.persist('checkin_undone', {operator, ticketId, reason}); break;
      case 'start_round': this.applyGameEvent({eventId: randomUUID(), type: 'GAME_STARTED', targetRoundId: roundId, occurredAt: this.now(), source: operator}); break;
      case 'pause_round': this.applyGameEvent({eventId: randomUUID(), type: 'GAME_PAUSED', targetRoundId: roundId, occurredAt: this.now(), source: operator}); break;
      case 'finish_round': this.applyGameEvent({eventId: randomUUID(), type: 'GAME_ENDED', targetRoundId: roundId, occurredAt: this.now(), source: operator}); break;
      default: throw Error('未対応の操作です');
    }
  }

  changeTicket(ticket, status, operator, reason) {
    if (!ticket) throw Error('整理券が見つかりません');
    const before = ticket.status;
    ticket.status = status; ticket.updatedAt = this.now();
    const assignedRound = ticket.roundId && this.round(ticket.roundId);
    if (['CANCELED', 'NO_SHOW', 'ON_HOLD'].includes(status) && assignedRound && ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(assignedRound.status)) {
      assignedRound.ticketIds = assignedRound.ticketIds.filter((id) => id !== ticket.id);
      ticket.roundId = null;
    }
    this.recalculate(false);
    this.persist('ticket_status_changed', {operator, reason, ticketId: ticket.id, details: {before, after: status}});
  }

  updateSettings(value, operator) {
    const input = value ?? {};
    const number = (name, minimum, maximum) => {
      const parsed = Number(input[name]);
      if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) throw Error(`${name} の値が範囲外です`);
      return parsed;
    };
    this.state.settings.cycleMinutes = SLOT_MINUTES;
    this.state.settings.globalDelayMinutes = number('globalDelayMinutes', 0, 600);
    this.state.settings.graceMinutes = number('graceMinutes', 1, 60);
    this.state.settings.maxWaitingGroups = number('maxWaitingGroups', 1, 1000);
    this.state.settings.autoCall = true;
    this.scheduleRounds();
    this.persist('settings_changed', {operator, details: clone(this.state.settings)});
  }

  applyGameEvent(event) {
    if (!event?.eventId || !event?.type) throw Error('イベントIDとイベント種別が必要です');
    if (this.state.processedGameEvents.includes(event.eventId)) return {duplicate: true};
    let round = event.targetRoundId && this.round(event.targetRoundId);
    if (!round) round = this.state.rounds.find((item) => ['CALLED', 'PLAYING'].includes(item.status));
    if (!round) throw Error('対象回が見つかりません');
    if (event.type === 'GAME_STARTED') {
      if (round.status !== 'CALLED') throw Error('呼出中の枠だけゲームを開始できます');
      const summary = this.roundSummary(round.id);
      if (!summary.assignedPeople || summary.checkedInPeople !== summary.assignedPeople) throw Error(`未入場者がいます（${summary.checkedInPeople}/${summary.assignedPeople}名入場済み）`);
    }
    const map = {GAME_STARTED: 'PLAYING', GAME_RESUMED: 'PLAYING', GAME_ENDED: 'COMPLETED'};
    if (event.type === 'GAME_PAUSED') {
      if (round.status !== 'PLAYING') throw Error('体験中の枠だけ一時停止できます');
      round.pausedAt = Number(event.occurredAt) || this.now();
      this.state.settings.globalDelayMinutes += 1;
    } else if (event.type === 'EQUIPMENT_TROUBLE') {
      const delay = Math.max(0, Math.min(120, Number(event.delayMinutes) || 0));
      this.state.settings.globalDelayMinutes += delay;
      if (event.message) this.state.globalMessage = String(event.message).slice(0, 500);
    } else if (map[event.type]) {
      round.status = map[event.type];
      if (round.status === 'PLAYING') { round.startedAt ??= Number(event.occurredAt) || this.now(); round.pausedAt = null; }
      if (round.status === 'COMPLETED') round.completedAt = Number(event.occurredAt) || this.now();
      for (const id of round.ticketIds) {
        const ticket = this.ticket(id);
        if (ticket && !terminalStates.has(ticket.status)) { ticket.status = round.status; ticket.updatedAt = this.now(); }
      }
    } else throw Error('未知のゲームイベントです');
    this.state.processedGameEvents.push(event.eventId);
    this.state.gameLastSeenAt = this.now();
    if (this.state.processedGameEvents.length > 5000) this.state.processedGameEvents.shift();
    this.scheduleRounds();
    this.persist('game_event', {operator: event.source || 'game-server', roundId: round.id, details: event});
    if (event.type === 'GAME_ENDED' && this.state.settings.autoCall && this.state.rounds.some((item) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(item.status))) this.callNext('automatic');
    return {duplicate: false, roundId: round.id};
  }
}
