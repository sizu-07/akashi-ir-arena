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
const SLOT_MS = SLOT_MINUTES * 60_000;
// 入場（呼出）開始は体験開始の10分前。前のゲームの開始ではなく、時刻で呼び出す。
const CALL_LEAD_MS = 10 * 60_000;
const MIN_REMAINING_OPENING_SLOT_MS = 5 * 60_000;
export const EVENT_WINDOWS = Object.freeze([
  {date:'2026-10-29',period:'public'}, {date:'2026-10-30',period:'public'},
  {date:'2026-10-31',period:'test'}, {date:'2026-10-31',period:'public'},
  {date:'2026-11-01',period:'test'}, {date:'2026-11-01',period:'public'},
]);
export const EVENT_SCHEDULE = Object.freeze([
  {date:'2026-10-29',period:'public',receptionStart:'10:00',slotStart:'10:00',slotEnd:'21:00'},
  {date:'2026-10-30',period:'public',receptionStart:'09:00',slotStart:'09:00',slotEnd:'21:00'},
  {date:'2026-10-31',period:'test',receptionStart:'08:00',slotStart:'08:00',slotEnd:'09:30'},
  {date:'2026-10-31',period:'public',receptionStart:'09:45',slotStart:'10:00',slotEnd:'15:00'},
  {date:'2026-11-01',period:'test',receptionStart:'08:00',slotStart:'08:00',slotEnd:'09:30'},
  {date:'2026-11-01',period:'public',receptionStart:'09:45',slotStart:'10:00',slotEnd:'15:00'},
]);
const eventDate = (timestamp) => new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Tokyo',year:'numeric',month:'2-digit',day:'2-digit'}).format(timestamp);
const eventTime = (date, time) => Date.parse(`${date}T${time}:00+09:00`);
const validEventTime = (value) => typeof value === 'string' && /^(?:[01]\d|2[0-3]):(?:00|15|30|45)$/.test(value);
const closedNotice = '受け付けは終了しました。もし枠が空いたら入れるかもしれません。';
const nextSlotBoundary = (value) => (Math.floor(value / SLOT_MS) + 1) * SLOT_MS;
const floorSlotBoundary = (value) => Math.floor(value / SLOT_MS) * SLOT_MS;
const isSlotBoundary = (value) => Number.isFinite(value) && value % SLOT_MS === 0;
const ceilSlotBoundary = (value) => Math.ceil(value / SLOT_MS) * SLOT_MS;
const adjustmentNotice = (slots) => slots > 0
  ? `現在、運営調整のため${slots}枠（${slots * SLOT_MINUTES}分）遅れています。調整枠は時間の経過に合わせて自動で消化されます。今後の状況により、入場予定時刻が変更される場合があります。`
  : '運営調整は終了しました。整理券画面の最新の入場予定時刻をご確認ください。';
export const SKIP_SEAT_NAME = 'スキップ枠';
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
const bestDisplacement = (tickets, peopleNeeded) => {
  let best = null;
  for (let mask = 1; mask < (1 << tickets.length); mask += 1) {
    const selected = tickets.filter((_, index) => mask & (1 << index));
    const people = selected.reduce((sum, ticket) => sum + ticket.partySize, 0);
    if (people < peopleNeeded) continue;
    if (!best || people < best.people || (people === best.people && selected.length < best.tickets.length)) best = {people, tickets: selected};
  }
  return best?.tickets ?? [];
};

export class TicketQueue {
  constructor({saved = null, save = () => {}, log = () => {}, now = Date.now, previewing = false, eventSchedule = null} = {}) {
    this.save = save;
    this.log = log;
    this.now = now;
    this.previewing = previewing;
    this.state = saved ?? {
      version: 3,
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
        ...(eventSchedule?{eventDays:clone(eventSchedule)}:{}),
      },
      tickets: [],
      rounds: [],
      processedGameEvents: [],
      updatedAt: now(),
    };
    this.state.settings = {...this.state.settings, cycleMinutes: SLOT_MINUTES, autoCall: true};
    this.state.settings.globalDelayMinutes = Math.min(600, Math.max(0, Math.ceil((Number(this.state.settings.globalDelayMinutes) || 0) / SLOT_MINUTES) * SLOT_MINUTES));
    this.state.settings.delayAnchorAt = isSlotBoundary(this.state.settings.delayAnchorAt) ? this.state.settings.delayAnchorAt : null;
    if (!this.state.settings.globalDelayMinutes) this.state.settings.delayAnchorAt = null;
    this.state.version = 3;
    for (const ticket of this.state.tickets) {
      if (!Array.isArray(ticket.playerNicknames) || ticket.playerNicknames.length !== ticket.partySize) {
        ticket.playerNicknames = legacyPlayerNames(ticket.nickname, ticket.partySize);
      }
    }
    for (const round of this.state.rounds) { round.skippedTicketIds ??= []; round.staffNames ??= []; }
    const membershipRepair = this.normalizeTicketRoundMembership();
    const activeRepair = this.normalizeActiveRounds();
    this.recalculate(false);
    this.ensureAdjustmentAnchor();
    this.withdrawEarlyCalledRound('automatic-recovery');
    this.advanceTime('automatic-recovery', {requireStarted: true});
    if (membershipRepair || activeRepair) this.persist('state_repaired', {
      reason: '整理券と枠の状態を正規化',
      details: {membershipRepair, activeRepair},
    });
  }

  normalizeTicketRoundMembership() {
    const repairedRoundIds = new Set();
    for (const round of this.state.rounds) {
      const assigned = [];
      const skipped = new Set((round.skippedTicketIds ?? []).filter((id) => this.ticket(id)?.status === 'NO_SHOW'));
      for (const id of new Set(round.ticketIds ?? [])) {
        const ticket = this.ticket(id);
        if (!ticket) { repairedRoundIds.add(round.id); continue; }
        if (['NO_SHOW', 'ON_HOLD', 'CANCELED', 'EXPIRED'].includes(ticket.status)) {
          if (ticket.status === 'NO_SHOW') skipped.add(id);
          repairedRoundIds.add(round.id);
        } else {
          assigned.push(id);
        }
      }
      if (assigned.length !== (round.ticketIds ?? []).length || skipped.size !== (round.skippedTicketIds ?? []).length) repairedRoundIds.add(round.id);
      round.ticketIds = assigned;
      round.skippedTicketIds = [...skipped];
    }
    for (const ticket of this.state.tickets.filter((item) => item.status === 'NO_SHOW' && item.roundId)) {
      const round = this.round(ticket.roundId);
      if (!round) continue;
      if (round.ticketIds.includes(ticket.id)) {
        round.ticketIds = round.ticketIds.filter((id) => id !== ticket.id);
        repairedRoundIds.add(round.id);
      }
      if (!round.skippedTicketIds.includes(ticket.id)) {
        round.skippedTicketIds.push(ticket.id);
        repairedRoundIds.add(round.id);
      }
    }
    for (const round of this.state.rounds) {
      if (round.status === 'CALLED' && !round.ticketIds.length) {
        round.status = 'SKIPPED';
        round.skippedAt ??= this.now();
        repairedRoundIds.add(round.id);
      }
    }
    return repairedRoundIds.size ? {repairedRoundIds: [...repairedRoundIds]} : null;
  }

  normalizeActiveRounds() {
    const playingRounds = this.state.rounds.filter((round) => round.status === 'PLAYING').sort((a, b) => a.number - b.number);
    const calledRounds = this.state.rounds.filter((round) => round.status === 'CALLED').sort((a, b) => a.number - b.number);
    const keepPlaying = playingRounds[0] ?? null;
    const validCalled = keepPlaying ? calledRounds.filter((round) => round.number > keepPlaying.number) : calledRounds;
    const keepCalled = validCalled.find((round) => round.ticketIds.some((id) => this.ticket(id)?.status === 'CHECKED_IN')) ?? validCalled[0] ?? null;
    const reset = [...playingRounds.slice(keepPlaying ? 1 : 0), ...calledRounds.filter((round) => round.id !== keepCalled?.id)];
    if (!reset.length) return null;
    const resetRoundIds = [];
    for (const round of reset) {
      resetRoundIds.push(round.id);
      round.status = 'SCHEDULED';
      round.calledAt = null;
      for (const id of round.ticketIds) {
        const ticket = this.ticket(id);
        if (!ticket || !['CALLED', 'CHECKED_IN', 'PLAYING'].includes(ticket.status)) continue;
        ticket.status = 'ASSIGNED';
        ticket.calledAt = null;
        ticket.checkedInAt = null;
        ticket.updatedAt = this.now();
      }
    }
    return {keptPlayingRoundId: keepPlaying?.id ?? null, keptCalledRoundId: keepCalled?.id ?? null, resetRoundIds};
  }

  persist(type, {operator = 'system', reason = '', ticketId = null, roundId = null, details = {}} = {}) {
    this.state.updatedAt = this.now();
    const event = {id: randomUUID(), at: this.state.updatedAt, type, operator, reason, ticketId, roundId, details};
    this.log(event);
    this.save(this.state);
    return event;
  }

  eventWindow() {
    if (!this.state.settings.eventDays) return null;
    const date = eventDate(this.now());
    const windows=this.state.settings.eventDays.filter((item)=>item.date===date && item.receptionStart && item.slotStart && item.slotEnd)
      .map((item)=>({date,period:item.period,configured:true,receptionStart:item.receptionStart,receptionStartAt:eventTime(date,item.receptionStart),slotStartAt:eventTime(date,item.slotStart),slotEndAt:eventTime(date,item.slotEnd)}))
      .sort((a,b)=>a.receptionStartAt-b.receptionStartAt);
    const active=windows.find((item)=>this.now()>=item.receptionStartAt && this.now()<item.slotEndAt-SLOT_MS);
    if(active)return active;
    const upcoming=windows.find((item)=>this.now()<item.receptionStartAt);
    if(upcoming)return {...upcoming,beforeOpen:true};
    return windows.length?{...windows.at(-1),ended:true}:date>EVENT_WINDOWS.at(-1).date?{date,configured:true,ended:true}:{date,configured:false};
  }

  registrationStatus() {
    const window = this.eventWindow();
    if (window?.ended) return {open:false,code:'ended',message:closedNotice};
    if (!this.state.registrationOpen) return {open:false,code:'manual',message:'現在、整理券の受付を停止しています。'};
    if (!window) return {open:true,code:'open',message:''};
    if (!window.configured) return {open:false,code:'unconfigured',message:'本日の整理券受付は準備中です。'};
    if (window.beforeOpen) return {open:false,code:'before_open',message:`受付開始は${window.receptionStart}です。`};
    return {open:true,code:'open',message:'',slotStartAt:window.slotStartAt,slotEndAt:window.slotEndAt};
  }

  registrationPreview(partySize, earliestCallAt = null) {
    const copy = new TicketQueue({saved: clone(this.state), now: this.now, previewing:true});
    const ticket = copy.register({
      requestId: randomUUID(), nicknames: Array.from({length: Number(partySize)}, (_, index) => `参加者${index + 1}`),
      partySize, consent: true, earliestCallAt,
    });
    return {estimatedCallAt: ticket.estimatedCallAt, slotStartAt: ticket.slotStartAt, slotEndAt: ticket.slotEndAt};
  }

  publicAvailability(partySize) {
    const size = Number(partySize);
    if (!Number.isInteger(size) || size < 1 || size > 4) throw Error('人数は1〜4人で入力してください');
    const registration = this.registrationStatus();
    if (!registration.open) return {registration,current:null,alternatives:[],updatedAt:this.state.updatedAt};
    const current = this.registrationPreview(partySize);
    if (registration.slotEndAt && current.slotEndAt > registration.slotEndAt) return {registration:{open:false,code:'ended',message:closedNotice},current:null,alternatives:[],updatedAt:this.state.updatedAt};
    const first = nextSlotBoundary(Math.max(this.now(), current.estimatedCallAt ?? this.now()));
    const alternatives = Array.from({length: 8}, (_, index) => {
      const earliestCallAt = first + index * SLOT_MS;
      return earliestCallAt <= this.now() + 24 * 60 * 60_000
        ? {earliestCallAt, ...this.registrationPreview(partySize, earliestCallAt)} : null;
    }).filter((option) => option && option.estimatedCallAt > current.estimatedCallAt && (!registration.slotEndAt || option.slotEndAt <= registration.slotEndAt));
    return {registration,current, alternatives, updatedAt: this.state.updatedAt};
  }

  register({nickname, nicknames, partySize, consent, requestId, earliestCallAt = null, expectedSlotStartAt = null}) {
    if (typeof requestId !== 'string' || requestId.length < 8 || requestId.length > 100) throw Error('登録要求IDが必要です');
    const existing = this.state.tickets.find((item) => item.registrationRequestId === requestId);
    if (existing) { this.save(this.state); return this.publicTicket(existing); }
    if (!this.previewing) {
      const registration = this.registrationStatus();
      if (!registration.open) throw Error(registration.message);
    }
    const size = Number(partySize);
    if (!Number.isInteger(size) || size < 1 || size > 4) throw Error('人数は1〜4人で入力してください');
    const legacyName = String(nickname ?? '').trim();
    const playerNames = Array.isArray(nicknames)
      ? nicknames.map((name) => String(name ?? '').trim())
      : legacyPlayerNames(legacyName, size);
    if (playerNames.length !== size) throw Error('参加人数とニックネームの数が一致しません');
    if (playerNames.some((name) => !name || name.length > 20)) throw Error('ニックネームは1人ずつ1〜20文字で入力してください');
    if (consent !== true) throw Error('注意事項への同意が必要です');
    if (earliestCallAt !== null) {
      if (!isSlotBoundary(earliestCallAt) || earliestCallAt <= this.now() || earliestCallAt > this.now() + 24 * 60 * 60_000) {
        throw Error('希望する案内時刻を選び直してください');
      }
    }
    const waiting = this.state.tickets.filter((item) => !terminalStates.has(item.status) && item.status !== 'PLAYING').length;
    if (waiting >= this.state.settings.maxWaitingGroups) throw Error('受付上限に達しました');
    if (!this.previewing) {
      const window=this.eventWindow();
      if(window?.configured && this.registrationPreview(size,earliestCallAt).slotEndAt>window.slotEndAt) throw Error(closedNotice);
    }
    if (expectedSlotStartAt !== null && this.registrationPreview(size, earliestCallAt).slotStartAt !== expectedSlotStartAt) {
      throw Error('案内時刻が更新されました。入力内容を確認し直してください');
    }
    const now = this.now();
    const queueWasDrained = this.state.rounds.some((round) => ['COMPLETED', 'SKIPPED'].includes(round.status))
      && !this.state.rounds.some((round) => ['CALLED', 'PLAYING', 'SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status));
    const window=this.eventWindow();
    const ticket = {
      id: randomUUID(),
      registrationRequestId: requestId,
      ticketNumber: `A${String(this.state.nextTicketNumber++).padStart(3, '0')}`,
      receptionNumber: this.state.nextReceptionNumber++,
      nickname: legacyName || playerNames.join('・'),
      playerNicknames: playerNames,
      partySize: size,
      earliestCallAt:window?.configured?Math.max(earliestCallAt??0,window.slotStartAt-SLOT_MS):earliestCallAt,
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
    const filledCalledRound = this.fillCalledRound();
    this.persist('ticket_registered', {ticketId: ticket.id, details: {ticketNumber: ticket.ticketNumber, partySize: size, receptionNumber: ticket.receptionNumber}});
    const shouldCallDuringPlaying = this.state.rounds.some((round) => round.status === 'PLAYING');
    if (queueWasDrained || shouldCallDuringPlaying) this.callDueRound('automatic-registration');
    else if (filledCalledRound.length) this.persist('called_round_filled', {
      roundId: filledCalledRound[0].roundId,
      details: {ticketIds: filledCalledRound.map((item) => item.ticketId), people: filledCalledRound.reduce((sum, item) => sum + item.partySize, 0)},
    });
    return this.publicTicket(ticket);
  }

  fillCalledRound() {
    const called = this.state.rounds.find((round) => round.status === 'CALLED');
    if (!called) return [];
    // スキップした組の席は「スキップ枠」として運営が入るため、後続の組で埋めない。
    const occupied = called.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0) + this.staffSeats(called);
    const capacity = 4 - occupied;
    if (capacity <= 0) return [];
    const candidates = this.state.tickets
      .filter((ticket) => ticket.status === 'ASSIGNED' && this.round(ticket.roundId)?.status === 'SCHEDULED'
        && (!ticket.earliestCallAt || ticket.earliestCallAt <= this.now()))
      .sort((a, b) => a.receptionNumber - b.receptionNumber);
    const fillIndexes = bestFillIndexes(candidates, capacity);
    const selected = fillIndexes.map((index) => candidates[index]);
    if (!selected.length) return [];
    const calledAt = called.calledAt ?? this.now();
    for (const ticket of selected) {
      const source = this.round(ticket.roundId);
      source.ticketIds = source.ticketIds.filter((id) => id !== ticket.id);
      called.ticketIds.push(ticket.id);
      ticket.roundId = called.id;
      ticket.status = 'CALLED';
      ticket.calledAt = calledAt;
      ticket.updatedAt = this.now();
    }
    this.recalculate(false);
    return selected.map((ticket) => ({ticketId: ticket.id, partySize: ticket.partySize, roundId: called.id}));
  }

  recalculate(record = true, operator = 'system', reason = '待機列を再計算') {
    const reusableRounds = this.state.rounds.filter((round) => round.status === 'SCHEDULED').sort((a, b) => a.number - b.number);
    const lockedRoundIds = new Set(this.state.rounds.filter((round) => round.status !== 'SCHEDULED').map((round) => round.id));
    const lockedTicketIds = new Set(this.state.tickets.filter((ticket) => ticket.roundId && lockedRoundIds.has(ticket.roundId)).map((ticket) => ticket.id));
    const candidates = this.state.tickets
      .filter((ticket) => mutableStates.has(ticket.status) && !lockedTicketIds.has(ticket.id))
      .sort((a, b) => (a.earliestCallAt ?? 0) - (b.earliestCallAt ?? 0) || a.receptionNumber - b.receptionNumber);

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
      const eligible = remaining.map((ticket, index) => ({ticket, index}))
        .filter(({ticket}) => (ticket.earliestCallAt ?? 0) === (assigned[0].earliestCallAt ?? 0));
      const fillIndexes = bestFillIndexes(eligible.map(({ticket}) => ticket), seats)
        .map((index) => eligible[index].index);
      assigned.push(...fillIndexes.map((index) => remaining[index]));
      for (const index of [...fillIndexes].reverse()) remaining.splice(index, 1);
      const round = reusableRounds[roundIndex++] ?? {
        id: randomUUID(), number: this.state.nextRoundNumber++, status: 'SCHEDULED',
        ticketIds: [], skippedTicketIds: [], slotStartAt: null, scheduledAt: null, calledAt: null, startedAt: null, completedAt: null, delayMinutes: 0,
      };
      round.skippedTicketIds ??= [];
      const nextTicketIds = assigned.map((ticket) => ticket.id);
      if (!round.manualSlotStartAt && round.ticketIds.join(',') !== nextTicketIds.join(',')) round.slotStartAt = null;
      round.ticketIds = nextTicketIds;
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
    const now = this.now();
    const playing = this.state.rounds.find((round) => round.status === 'PLAYING');
    const called = this.state.rounds.find((round) => round.status === 'CALLED');
    let nextSlot = null;
    const compact = !this.state.settings.globalDelayMinutes;
    const applyEstimate = (round) => {
      round.scheduledAt = round.slotStartAt + (this.state.settings.globalDelayMinutes + (round.delayMinutes ?? 0)) * 60_000;
    };
    if (playing) {
      if (!isSlotBoundary(playing.slotStartAt)) playing.slotStartAt = floorSlotBoundary(playing.scheduledAt ?? playing.startedAt ?? now);
      playing.activeSlotStartAt ??= playing.scheduledAt ?? playing.slotStartAt;
      playing.scheduledAt = playing.activeSlotStartAt;
      // 調整枠がないときは、体験中の枠が実際に使っている時間のすぐ後ろから並べる。
      nextSlot = (compact ? Math.max(playing.slotStartAt, floorSlotBoundary(playing.activeSlotStartAt)) : playing.slotStartAt) + SLOT_MS;
    }
    if (called) {
      const minimum = playing ? nextSlot : (isSlotBoundary(called.slotStartAt) ? called.slotStartAt : nextSlotBoundary(now));
      if (!isSlotBoundary(called.slotStartAt)) called.slotStartAt = called.manualSlotStartAt ?? minimum;
      else if (playing && called.slotStartAt < minimum) called.slotStartAt = called.manualSlotStartAt && called.manualSlotStartAt >= minimum ? called.manualSlotStartAt : minimum;
      applyEstimate(called);
      nextSlot = called.slotStartAt + SLOT_MS;
    }
    const scheduled = this.state.rounds.filter((round) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)).sort((a, b) => a.number - b.number);
    const eventWindow=this.eventWindow();
    if (nextSlot === null) {
      const openingSlotAvailable=eventWindow?.configured && now>=eventWindow.slotStartAt
        && now<=eventWindow.slotStartAt+SLOT_MS-MIN_REMAINING_OPENING_SLOT_MS;
      const earliest = openingSlotAvailable ? eventWindow.slotStartAt : nextSlotBoundary(now);
      const first = scheduled[0]?.slotStartAt;
      // 調整枠がないときは、先頭の予定枠を今から入れる最も早い枠まで前に詰める（呼出時刻を迎えた枠はそのまま）。
      nextSlot = !isSlotBoundary(first) ? earliest : compact && first > earliest ? earliest : first;
    }
    // 呼出中・体験中の枠の後ろで待つ枠は、すでに始まった時間帯を案内しない（前の枠が遅れていれば一緒に後ろへずれる）。
    const notBefore = !compact ? 0 : playing || called ? nextSlotBoundary(now) : floorSlotBoundary(now);
    if (eventWindow?.configured&&!isSlotBoundary(scheduled[0]?.slotStartAt)) nextSlot=Math.max(nextSlot,eventWindow.slotStartAt);
    for (const round of scheduled) {
      const manual = round.manualSlotStartAt ?? (isSlotBoundary(round.manualScheduledAt) ? round.manualScheduledAt : null);
      // 調整枠の消化中は案内済みの時刻を保つ。調整枠がないときは手動指定以外の枠を前へ詰め、空き枠を残さない。
      const existing = !compact && isSlotBoundary(round.slotStartAt) ? round.slotStartAt : null;
      const earliestCallAt = Math.max(0, ...round.ticketIds.map((id) => this.ticket(id)?.earliestCallAt ?? 0));
      const delayMs = (this.state.settings.globalDelayMinutes + (round.delayMinutes ?? 0)) * 60_000;
      const requestedStart = earliestCallAt ? ceilSlotBoundary(earliestCallAt + SLOT_MS - delayMs) : 0;
      round.slotStartAt = Math.max(nextSlot, requestedStart, manual ?? existing ?? 0, notBefore);
      applyEstimate(round);
      nextSlot = round.slotStartAt + SLOT_MS;
    }
  }

  adjustmentRounds() {
    return this.state.rounds
      .filter((round) => ['CALLED', 'SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status))
      .sort((a, b) => a.number - b.number);
  }

  shiftAdjustmentRounds(milliseconds) {
    if (!milliseconds) return;
    for (const round of this.adjustmentRounds()) {
      if (Number.isFinite(round.slotStartAt)) round.slotStartAt += milliseconds;
      if (Number.isFinite(round.manualSlotStartAt)) round.manualSlotStartAt += milliseconds;
      if (Number.isFinite(round.manualScheduledAt)) round.manualScheduledAt += milliseconds;
    }
  }

  ensureAdjustmentAnchor() {
    if (!this.state.settings.globalDelayMinutes) {
      this.state.settings.delayAnchorAt = null;
      return null;
    }
    if (isSlotBoundary(this.state.settings.delayAnchorAt)) return this.state.settings.delayAnchorAt;
    const affected = this.adjustmentRounds().filter((round) => isSlotBoundary(round.slotStartAt));
    const earliest = affected.length ? Math.min(...affected.map((round) => round.slotStartAt)) : null;
    const anchor = Math.max(floorSlotBoundary(this.now()), earliest ?? floorSlotBoundary(this.now()));
    if (earliest !== null && earliest < anchor) this.shiftAdjustmentRounds(anchor - earliest);
    this.state.settings.delayAnchorAt = anchor;
    this.scheduleRounds();
    return anchor;
  }

  consumeElapsedAdjustmentSlots(operator = 'automatic-time') {
    const remainingSlots = Math.floor(this.state.settings.globalDelayMinutes / SLOT_MINUTES);
    if (!remainingSlots) return 0;
    const anchor = this.ensureAdjustmentAnchor();
    const elapsedSlots = Math.min(remainingSlots, Math.max(0, Math.floor((this.now() - anchor) / SLOT_MS)));
    if (!elapsedSlots) return 0;
    const elapsedMilliseconds = elapsedSlots * SLOT_MS;
    this.shiftAdjustmentRounds(elapsedMilliseconds);
    const nextSlots = remainingSlots - elapsedSlots;
    this.state.settings.globalDelayMinutes = nextSlots * SLOT_MINUTES;
    this.state.settings.delayAnchorAt = nextSlots ? anchor + elapsedMilliseconds : null;
    this.state.globalMessage = adjustmentNotice(nextSlots);
    this.scheduleRounds();
    this.persist('adjustment_slots_elapsed', {
      operator,
      reason: '調整枠の終了時刻に到達',
      details: {elapsedSlots, remainingSlots: nextSlots},
    });
    return elapsedSlots;
  }

  completeExpiredPlayingRound(operator = 'automatic-time') {
    const round = this.state.rounds.find((item) => item.status === 'PLAYING');
    if (!round || round.pausedAt) return null;
    const startedSlot = round.activeSlotStartAt ?? round.scheduledAt ?? round.slotStartAt;
    if (!Number.isFinite(startedSlot) || this.now() < startedSlot + SLOT_MS) return null;
    round.status = 'COMPLETED';
    round.completedAt = this.now();
    for (const id of round.ticketIds) {
      const ticket = this.ticket(id);
      if (ticket && !terminalStates.has(ticket.status)) {
        ticket.status = 'COMPLETED';
        ticket.updatedAt = this.now();
      }
    }
    this.scheduleRounds();
    this.persist('round_auto_completed', {
      operator,
      reason: '固定枠の終了時刻を過ぎたため自動完了',
      roundId: round.id,
      details: {number: round.number, scheduledEndAt: startedSlot + SLOT_MS},
    });
    return round;
  }

  advanceTime(operator = 'automatic-time', {requireStarted = false} = {}) {
    const elapsedAdjustmentSlots = this.consumeElapsedAdjustmentSlots(operator);
    const completedRound = this.completeExpiredPlayingRound(operator);
    const calledRound = this.callDueRound(operator, {requireStarted});
    return {changed: Boolean(elapsedAdjustmentSlots || completedRound || calledRound), elapsedAdjustmentSlots, completedRound, calledRound};
  }

  skippedSeats(round) {
    return (round.skippedTicketIds ?? []).reduce((sum, id) => sum + (this.ticket(id)?.status === 'NO_SHOW' ? this.ticket(id).partySize : 0), 0);
  }

  ticketSeats(round) {
    return round.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0);
  }

  // 整理券の組以外の席（運営が入る席）の名前。運営が名前を入力した席を先に並べ、
  // 名前のないスキップ席は「スキップ枠」とする。
  staffSeatNames(round) {
    const open = Math.max(0, 4 - this.ticketSeats(round));
    const named = (round.staffNames ?? []).slice(0, open);
    const unnamed = Math.max(0, Math.min(open, this.skippedSeats(round)) - named.length);
    return [...named, ...Array(unnamed).fill(SKIP_SEAT_NAME)];
  }

  staffSeats(round) {
    return this.staffSeatNames(round).length;
  }

  roundPlayerNicknames(round) {
    return [...round.ticketIds.flatMap(id => this.ticket(id)?.playerNicknames ?? []), ...this.staffSeatNames(round)];
  }

  roundAdmittedPlayerNicknames(round) {
    return round.ticketIds.flatMap((id) => {
      const ticket = this.ticket(id);
      return (ticket?.playerNicknames ?? []).map((name) => ['CHECKED_IN', 'PLAYING'].includes(ticket.status) ? name : null);
    }).concat(this.staffSeatNames(round));
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
    const showSchedule = !terminalStates.has(ticket.status);
    const plannedCallAt = showSchedule && round?.scheduledAt ? round.scheduledAt - CALL_LEAD_MS : null;
    const estimatedCallAt = showSchedule && round ? (['CALLED', 'CHECKED_IN', 'PLAYING'].includes(ticket.status) && ticket.calledAt
      ? Math.max(ticket.calledAt, plannedCallAt ?? ticket.calledAt)
      : plannedCallAt ? Math.max(plannedCallAt, this.now()) : null) : null;
    const waitMinutes = estimatedCallAt ? Math.max(0, Math.ceil((estimatedCallAt - this.now()) / 60_000)) : null;
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
      estimatedCallAt,
      slotStartAt: showSchedule ? round?.scheduledAt ?? null : null,
      slotEndAt: showSchedule && round?.scheduledAt ? round.scheduledAt + SLOT_MS : null,
      globalMessage: this.state.globalMessage,
      personalMessage: ticket.personalMessage,
      qrToken: ticket.qrToken,
      accessToken: ticket.accessToken,
      updatedAt: this.state.updatedAt,
    };
  }

  operatorView() {
    const tickets = this.state.tickets.map((ticket) => ({...ticket, accessToken: undefined, qrToken: undefined}));
    const ticketSummary = (id) => {
      const ticket = this.ticket(id);
      return ticket && {id: ticket.id, ticketNumber: ticket.ticketNumber, nickname: ticket.nickname, playerNicknames: clone(ticket.playerNicknames), partySize: ticket.partySize, status: ticket.status};
    };
    const rounds = this.state.rounds.sort((a, b) => a.number - b.number).map((round) => {
      const plannedCallAt = round.scheduledAt ? round.scheduledAt - CALL_LEAD_MS : null;
      const callAt = round.status === 'CALLED' && round.calledAt
        ? Math.max(round.calledAt, plannedCallAt ?? round.calledAt)
        : plannedCallAt ? Math.max(plannedCallAt, this.now()) : null;
      return {
        ...round,
        callAt,
        effectiveSlotStartAt: round.scheduledAt ?? round.slotStartAt ?? null,
        effectiveSlotEndAt: (round.scheduledAt ?? round.slotStartAt) ? (round.scheduledAt ?? round.slotStartAt) + SLOT_MS : null,
        slotEndAt: round.slotStartAt ? round.slotStartAt + SLOT_MS : null,
        assignedPeople: round.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0),
        checkedInPeople: round.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.status === 'CHECKED_IN' ? this.ticket(id).partySize : 0), 0),
        skippedPeople: (round.skippedTicketIds ?? []).reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0),
        tickets: round.ticketIds.map(ticketSummary).filter(Boolean),
        skippedTickets: (round.skippedTicketIds ?? []).map(ticketSummary).filter(Boolean),
        staffSeatNames: this.staffSeatNames(round),
      };
    });
    return {registrationOpen: this.state.registrationOpen, registrationStatus:this.registrationStatus(), globalMessage: this.state.globalMessage, settings: clone(this.state.settings), tickets, rounds, gameLastSeenAt: this.state.gameLastSeenAt ?? null, updatedAt: this.state.updatedAt};
  }

  ticket(id) { return this.state.tickets.find((item) => item.id === id); }
  round(id) { return this.state.rounds.find((item) => item.id === id); }

  callNext(operator) {
    const called = this.state.rounds.find((item) => item.status === 'CALLED');
    if (called) throw Error(`第${called.number}枠を呼出中です。次の枠はまだ呼び出せません`);
    this.scheduleRounds();
    const round = this.state.rounds.filter((item) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(item.status)).sort((a, b) => a.number - b.number)[0];
    if (!round) throw Error('呼び出せる予定回がありません');
    // 自動の呼出は開始10分前。運営の手動呼出は、従来どおり開始15分前から早めに行える。
    const callAt = round.scheduledAt - SLOT_MS;
    if (this.now() < callAt) throw Error(`第${round.number}枠は${new Date(callAt).toLocaleTimeString('ja-JP', {hour: '2-digit', minute: '2-digit'})}から呼び出します`);
    round.status = 'CALLED';
    round.calledAt = this.now();
    round.firstCalledAt ??= round.calledAt;
    for (const id of round.ticketIds) {
      const ticket = this.ticket(id);
      ticket.status = 'CALLED'; ticket.calledAt = round.calledAt; ticket.updatedAt = round.calledAt;
    }
    this.scheduleRounds();
    this.persist('round_called', {operator, roundId: round.id, details: {number: round.number}});
    return round;
  }

  callDueRound(operator = 'automatic-time', {requireStarted = false} = {}) {
    if (!this.state.settings.autoCall || this.state.rounds.some((round) => round.status === 'CALLED')) return null;
    if (requireStarted
      && !this.state.rounds.some((round) => ['PLAYING', 'COMPLETED', 'SKIPPED'].includes(round.status))
      && !this.state.rounds.some((round) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status) && round.firstCalledAt)) return null;
    this.scheduleRounds();
    const round = this.state.rounds.filter((item) => ['SCHEDULED', 'LOCKED_SCHEDULED'].includes(item.status)).sort((a, b) => a.number - b.number)[0];
    if (!round || !round.scheduledAt || this.now() < round.scheduledAt - CALL_LEAD_MS) return null;
    return this.callNext(operator);
  }

  withdrawEarlyCalledRound(operator = 'system') {
    const round = this.state.rounds.find((item) => item.status === 'CALLED');
    if (!round?.scheduledAt || this.now() >= round.scheduledAt - CALL_LEAD_MS) return null;
    const hasCheckedIn = round.ticketIds.some((id) => this.ticket(id)?.status === 'CHECKED_IN');
    if (hasCheckedIn) return null;
    const previousCalledAt = round.calledAt;
    round.firstCalledAt ??= previousCalledAt ?? this.now();
    round.status = round.manualSlotStartAt || round.manualScheduledAt ? 'LOCKED_SCHEDULED' : 'SCHEDULED';
    round.calledAt = null;
    for (const id of round.ticketIds) {
      const ticket = this.ticket(id);
      if (!ticket || ticket.status !== 'CALLED') continue;
      ticket.status = 'ASSIGNED';
      ticket.calledAt = null;
      ticket.updatedAt = this.now();
    }
    this.persist('round_call_withdrawn', {
      operator,
      reason: '調整により呼出予定時刻が未来へ移動',
      roundId: round.id,
      details: {number: round.number, previousCalledAt, nextCallAt: round.scheduledAt - CALL_LEAD_MS},
    });
    return round;
  }

  removeCalledGroup(ticketId, status, operator, reason, eventType = 'called_group_removed') {
    const ticket = this.ticket(ticketId);
    if (!ticket) throw Error('整理券が見つかりません');
    if (ticket.status !== 'CALLED') throw Error('呼出中で未入場のグループだけをスキップできます');
    if (!['NO_SHOW', 'ON_HOLD', 'CANCELED'].includes(status)) throw Error('呼出中グループの変更先が不正です');
    const round = this.round(ticket.roundId);
    if (!round || round.status !== 'CALLED' || !round.ticketIds.includes(ticket.id)) throw Error('呼出中の枠にいるグループを選んでください');
    round.ticketIds = round.ticketIds.filter((id) => id !== ticket.id);
    round.skippedTicketIds = (round.skippedTicketIds ?? []).filter((id) => id !== ticket.id);
    if (status === 'NO_SHOW') round.skippedTicketIds.push(ticket.id);
    const before = ticket.status;
    ticket.status = status;
    ticket.updatedAt = this.now();
    this.recalculate(false);
    const filled = this.fillCalledRound();
    // スキップ枠が残っている枠は運営が入って実施するので、空き枠として飛ばさない。
    const becameEmpty = round.ticketIds.length === 0 && this.staffSeats(round) === 0;
    if (becameEmpty) {
      round.status = 'SKIPPED';
      round.skippedAt = this.now();
      this.scheduleRounds();
    }
    this.persist(eventType, {
      operator,
      reason,
      ticketId: ticket.id,
      roundId: round.id,
      details: {ticketNumber: ticket.ticketNumber, partySize: ticket.partySize, before, after: status, filledTicketIds: filled.map((item) => item.ticketId)},
    });
    let nextCalledRound = null;
    if (becameEmpty) nextCalledRound = this.callDueRound(operator);
    return {round, ticket, filled, nextCalledRound};
  }

  skipCalledGroup(ticketId, operator, reason) {
    return this.removeCalledGroup(ticketId, 'NO_SHOW', operator, reason, 'called_group_skipped');
  }

  recallSkippedGroup(ticketId, operator, reason) {
    const ticket = this.ticket(ticketId);
    if (!ticket || ticket.status !== 'NO_SHOW') throw Error('スキップ済みのグループを選んでください');
    const active = this.state.rounds.find((round) => round.status === 'CALLED');
    const playing = this.state.rounds.find((round) => round.status === 'PLAYING');
    const sourceRound = this.round(ticket.roundId);
    let target = active;
    if (!target && !playing && sourceRound?.status === 'SKIPPED') {
      target = sourceRound;
      target.status = 'CALLED';
      target.calledAt = this.now();
      target.slotStartAt = nextSlotBoundary(this.now());
      target.skippedAt = null;
    }
    if (!target) {
      target = {
        id: randomUUID(), number: this.state.nextRoundNumber++, status: 'CALLED', ticketIds: [], skippedTicketIds: [],
        slotStartAt: playing?.slotStartAt ? playing.slotStartAt + SLOT_MS : nextSlotBoundary(this.now()), scheduledAt: null, calledAt: this.now(), startedAt: null, completedAt: null, delayMinutes: 0,
      };
      this.state.rounds.push(target);
    }

    const occupied = target.ticketIds.reduce((sum, id) => sum + (this.ticket(id)?.partySize ?? 0), 0);
    const peopleNeeded = Math.max(0, occupied + ticket.partySize - 4);
    const displacementCandidates = target.ticketIds
      .map((id) => this.ticket(id))
      .filter((item) => item?.status === 'CALLED' && item.receptionNumber > ticket.receptionNumber)
      .sort((a, b) => b.receptionNumber - a.receptionNumber);
    const displaced = peopleNeeded ? bestDisplacement(displacementCandidates, peopleNeeded) : [];
    if (peopleNeeded && !displaced.length) throw Error('入場済みまたは先着のグループがいるため、この組を現在の枠へ戻せません');
    const displacedIds = new Set(displaced.map((item) => item.id));
    target.ticketIds = target.ticketIds.filter((id) => !displacedIds.has(id));
    for (const item of displaced) {
      item.status = 'WAITING'; item.roundId = null; item.calledAt = null; item.updatedAt = this.now();
    }
    for (const round of this.state.rounds) round.skippedTicketIds = (round.skippedTicketIds ?? []).filter((id) => id !== ticket.id);
    if (!target.ticketIds.includes(ticket.id)) target.ticketIds.push(ticket.id);
    ticket.status = 'CALLED'; ticket.roundId = target.id; ticket.calledAt = target.calledAt ?? this.now(); ticket.updatedAt = this.now();
    this.recalculate(false);
    const filled = this.fillCalledRound();
    this.scheduleRounds();
    this.persist('skipped_group_recalled', {
      operator, reason, ticketId: ticket.id, roundId: target.id,
      details: {ticketNumber: ticket.ticketNumber, sourceRoundId: sourceRound?.id ?? null, displacedTicketIds: [...displacedIds], filledTicketIds: filled.map((item) => item.ticketId)},
    });
    return {round: target, ticket, displaced, filled};
  }

  recallPastRound(roundId, operator, reason) {
    const target = this.round(roundId);
    if (!target || !['SKIPPED', 'COMPLETED'].includes(target.status)) throw Error('スキップ済みまたは終了済みの過去枠を選んでください');
    const previousStatus = target.status;
    if (previousStatus === 'SKIPPED' && !target.ticketIds.length && target.skippedTicketIds?.length) throw Error('グループ単位でスキップした整理券は、整理券一覧から待機列へ戻してください');
    const recallableStatus = previousStatus === 'COMPLETED' ? 'COMPLETED' : 'NO_SHOW';
    const pastTicketIds = previousStatus === 'SKIPPED' ? [...target.ticketIds, ...(target.skippedTicketIds ?? [])] : target.ticketIds;
    const recallableTickets = pastTicketIds.map((id) => this.ticket(id)).filter((ticket) => ticket?.status === recallableStatus);
    if (!recallableTickets.length) throw Error('この枠には再呼出しできる整理券がありません');
    const active = this.state.rounds.find((item) => ['CALLED', 'PLAYING'].includes(item.status));
    if (active?.status === 'PLAYING') throw Error(`第${active.number}枠が体験中のため、過去枠へ切り替えられません`);
    if (active) throw Error(`第${active.number}枠を呼出中です。各グループの対応を終えてから過去枠を呼び出してください`);
    const recalledAt = this.now();
    target.status = 'CALLED';
    target.calledAt = recalledAt;
    target.scheduledAt = recalledAt;
    target.startedAt = null;
    target.completedAt = null;
    target.pausedAt = null;
    target.ticketIds = recallableTickets.map((ticket) => ticket.id);
    target.skippedTicketIds = [];
    for (const ticket of recallableTickets) {
      ticket.status = 'CALLED';
      ticket.calledAt = recalledAt;
      ticket.updatedAt = recalledAt;
    }
    this.scheduleRounds();
    this.persist('past_round_recalled', {operator, reason, roundId: target.id, details: {number: target.number, previousStatus}});
    return target;
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
    const assignedPeople = tickets.reduce((sum, item) => sum + item.partySize, 0), skippedPeople = this.skippedSeats(round), staffSeats = this.staffSeats(round);
    const checkedInPeople = tickets.filter((item) => item.status === 'CHECKED_IN').reduce((sum, item) => sum + item.partySize, 0);
    // 運営が入る席（スキップ枠・運営の名前を入れた席）は入場済みとして扱い4席に数える。
    return {number: round.number, checkedInPeople, assignedPeople, skippedPeople, staffSeats, ready: assignedPeople + staffSeats === 4 && checkedInPeople === assignedPeople};
  }

  cancelByVisitor(accessToken) {
    const ticket = this.state.tickets.find((item) => item.accessToken === accessToken);
    if (!ticket) throw Error('整理券が見つかりません');
    if (!mutableStates.has(ticket.status)) throw Error('この整理券は現在キャンセルできません');
    this.changeTicket(ticket, 'CANCELED', 'visitor', '来場者による取消');
  }

  operatorAction({action, ticketId, roundId, value, reason, operator}) {
    const important = new Set(['hold', 'cancel', 'no_show', 'skip_group', 'recall_group', 'move_round', 'round_time', 'undo_checkin', 'recall_skipped', 'recall_past']);
    if (important.has(action) && !String(reason ?? '').trim()) throw Error('この操作には理由が必要です');
    const ticket = ticketId && this.ticket(ticketId);
    if (ticketId && !ticket) throw Error('整理券が見つかりません');
    switch (action) {
      case 'registration': this.state.registrationOpen = Boolean(value); this.persist('registration_changed', {operator, details: {open: Boolean(value)}}); break;
      case 'event_days': this.updateEventDays(value,operator); break;
      case 'call_next': this.callNext(operator); break;
      case 'fill_staff': {
        // 呼出中の枠の空き席（スキップ席を含む）に、入力した名前で運営が入る。空の配列で解除。
        const round = this.round(roundId);
        if (!round || round.status !== 'CALLED') throw Error('呼出中の枠を選んでください');
        const names = Array.isArray(value) ? value.map((name) => String(name ?? '').trim()) : [];
        const open = 4 - this.ticketSeats(round);
        if (names.length && names.length !== open) throw Error(`空いている${open}席すべての名前を入力してください`);
        if (names.some((name) => !name || [...name].length > 20)) throw Error('運営の名前は1〜20文字で入力してください');
        round.staffNames = names;
        this.persist(names.length ? 'staff_seats_filled' : 'staff_seats_cleared', {operator, roundId, details: {names}});
        return {notice: names.length ? `第${round.number}枠の空き${open}席に運営（${names.join('・')}）が入ります。` : `第${round.number}枠の運営の席を外しました。`};
      }
      case 'recall': {
        const round = this.round(roundId); if (!round || round.status !== 'CALLED') throw Error('呼出中の回を選んでください');
        this.persist('round_recalled', {operator, roundId}); break;
      }
      case 'skip_group': {
        const result = this.skipCalledGroup(ticketId, operator, reason);
        const fillText = ` ${result.ticket.partySize}席はスキップ枠として運営が入ります。後ろの組は繰り上げません。`;
        const nextText = result.nextCalledRound ? ` 第${result.nextCalledRound.number}枠を自動で呼び出しました。` : '';
        return {notice: `${result.ticket.ticketNumber}をスキップ済みにしました。${fillText}${nextText}`.replace(/\s+/g, ' ').trim()};
      }
      case 'recall_group': {
        const result = this.recallSkippedGroup(ticketId, operator, reason);
        const displacedText = result.displaced.length ? ` ${result.displaced.map((item) => item.ticketNumber).join('・')}は待機列へ戻しました。` : '';
        return {notice: `${result.ticket.ticketNumber}のスキップを取り消し、第${result.round.number}枠で呼び戻しました。${displacedText}`.replace(/\s+/g, ' ').trim()};
      }
      case 'recall_skipped':
      case 'recall_past': this.recallPastRound(roundId, operator, reason); break;
      case 'hold': {
        if (!['WAITING', 'ASSIGNED', 'CALLED'].includes(ticket.status)) throw Error('この状態の整理券は保留にできません');
        if (ticket.status === 'CALLED') this.removeCalledGroup(ticket.id, 'ON_HOLD', operator, reason, 'called_group_held');
        else this.changeTicket(ticket, 'ON_HOLD', operator, reason); break;
      }
      case 'release': {
        if (ticket.status !== 'ON_HOLD') throw Error('保留中ではありません');
        for (const round of this.state.rounds) round.skippedTicketIds = (round.skippedTicketIds ?? []).filter((id) => id !== ticket.id);
        ticket.status = 'WAITING'; ticket.roundId = null; this.recalculate(false);
        const filled = this.fillCalledRound();
        this.persist('ticket_released', {operator, ticketId, reason, details: {filledRoundId: filled[0]?.roundId ?? null}}); break;
      }
      case 'cancel': {
        if (ticket.status === 'CHECKED_IN') throw Error('入場処理を取り消してから整理券を取消してください');
        if (terminalStates.has(ticket.status) || ticket.status === 'PLAYING') throw Error('この状態の整理券は取消できません');
        if (ticket.status === 'CALLED') this.removeCalledGroup(ticket.id, 'CANCELED', operator, reason, 'called_group_canceled');
        else this.changeTicket(ticket, 'CANCELED', operator, reason); break;
      }
      case 'no_show': this.skipCalledGroup(ticketId, operator, reason); break;
      case 'return_queue': {
        if (!['ON_HOLD', 'NO_SHOW', 'CANCELED'].includes(ticket.status)) throw Error('保留・来場なし・取消の整理券だけを待機列へ戻せます');
        for (const round of this.state.rounds) round.skippedTicketIds = (round.skippedTicketIds ?? []).filter((id) => id !== ticket.id);
        ticket.status = 'WAITING'; ticket.roundId = null; this.recalculate(false);
        const filled = this.fillCalledRound();
        this.persist('ticket_returned', {operator, ticketId, reason: reason || '待機列へ戻す', details: {filledRoundId: filled[0]?.roundId ?? null}}); break;
      }
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
        if (!isSlotBoundary(at)) throw Error('予定時刻は00・15・30・45分のいずれかを指定してください');
        const before = round.slotStartAt; round.manualSlotStartAt = at; round.manualScheduledAt = null; round.status = 'LOCKED_SCHEDULED'; this.scheduleRounds();
        this.persist('round_time_changed', {operator, reason, roundId, details: {before, after: round.slotStartAt}}); break;
      }
      case 'round_time_auto': {
        // 手動で指定した時刻を外し、自動の並び（前の枠のすぐ後ろ）に戻す。
        const round = this.round(roundId);
        if (!round || !['SCHEDULED', 'LOCKED_SCHEDULED'].includes(round.status)) throw Error('予定中の回を選んでください');
        const before = round.slotStartAt; round.manualSlotStartAt = null; round.manualScheduledAt = null; round.status = 'SCHEDULED'; this.scheduleRounds();
        this.persist('round_time_auto', {operator, reason, roundId, details: {before, after: round.slotStartAt}});
        return {notice: `第${round.number}枠を自動の時刻（${new Date(round.scheduledAt).toLocaleTimeString('ja-JP', {timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit'})}〜）に戻しました。`};
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
    this.consumeElapsedAdjustmentSlots(operator);
    this.state.settings.cycleMinutes = SLOT_MINUTES;
    const previousDelayMinutes = this.state.settings.globalDelayMinutes;
    const delaySlots = input.globalDelaySlots === undefined
      ? Math.ceil(number('globalDelayMinutes', 0, 600) / SLOT_MINUTES)
      : number('globalDelaySlots', 0, 40);
    this.state.settings.globalDelayMinutes = delaySlots * SLOT_MINUTES;
    if (this.state.settings.globalDelayMinutes > previousDelayMinutes && !previousDelayMinutes) this.state.settings.delayAnchorAt = null;
    if (this.state.settings.globalDelayMinutes) this.ensureAdjustmentAnchor();
    else this.state.settings.delayAnchorAt = null;
    this.state.settings.graceMinutes = number('graceMinutes', 1, 60);
    this.state.settings.maxWaitingGroups = number('maxWaitingGroups', 1, 1000);
    this.state.settings.autoCall = true;
    if (this.state.settings.globalDelayMinutes !== previousDelayMinutes) this.state.globalMessage = adjustmentNotice(delaySlots);
    this.scheduleRounds();
    const withdrawnRound = this.withdrawEarlyCalledRound(operator);
    this.persist('settings_changed', {operator, details: clone(this.state.settings)});
    if (withdrawnRound || this.state.settings.globalDelayMinutes < previousDelayMinutes) this.callDueRound(operator, {requireStarted: true});
  }

  updateEventDays(value,operator) {
    if (!Array.isArray(value) || value.length!==EVENT_WINDOWS.length) throw Error('6つの時間帯を入力してください');
    const days=EVENT_WINDOWS.map(({date,period},index)=>{
      const input=value[index];
      if(input?.date!==date||input?.period!==period) throw Error('日付と時間帯が一致しません');
      const times=['receptionStart','slotStart','slotEnd'].map((key)=>String(input[key]??''));
      if(times.every((time)=>time==='')) return {date,period,receptionStart:'',slotStart:'',slotEnd:''};
      if(times.some((time)=>!validEventTime(time))) throw Error(`${date}の時刻は00・15・30・45分で入力してください`);
      if(!(times[0]<=times[1] && times[1]<times[2])) throw Error(`${date}は受付開始≦最初の枠＜最終枠終了の順にしてください`);
      if(eventTime(date,times[2])-eventTime(date,times[1])<SLOT_MS) throw Error(`${date}には15分以上の枠が必要です`);
      return {date,period,receptionStart:times[0],slotStart:times[1],slotEnd:times[2]};
    });
    for(const date of new Set(days.map((day)=>day.date))){
      const [first,second]=days.filter((day)=>day.date===date);
      if(second?.receptionStart&&first?.slotEnd&&second.receptionStart<first.slotEnd) throw Error(`${date}の時間帯が重なっています`);
    }
    const protectedDates=new Set(this.state.tickets.filter((ticket)=>!terminalStates.has(ticket.status)).map((ticket)=>this.round(ticket.roundId)?.scheduledAt).filter(Number.isFinite).map(eventDate));
    for(const date of protectedDates){
      const previous=this.state.settings.eventDays?.filter((day)=>day.date===date)??[];
      const next=days.filter((day)=>day.date===date);
      if(JSON.stringify(previous)!==JSON.stringify(next)) throw Error(`${date}の有効な整理券があるため、この日の時間は変更できません`);
    }
    this.state.settings.eventDays=days;
    this.scheduleRounds();
    this.persist('event_days_changed',{operator,details:{days}});
  }

  applyGameEvent(event) {
    if (!event?.eventId || !event?.type) throw Error('イベントIDとイベント種別が必要です');
    if (this.state.processedGameEvents.includes(event.eventId)) return {duplicate: true};
    if (!event.targetRoundId) throw Error('ゲームイベントには対象枠IDが必要です');
    const round = this.round(event.targetRoundId);
    if (!round) throw Error('対象回が見つかりません');
    if (event.type === 'GAME_STARTED') {
      if (round.status !== 'CALLED') throw Error('呼出中の枠だけゲームを開始できます');
      const otherPlaying = this.state.rounds.find((item) => item.status === 'PLAYING' && item.id !== round.id);
      if (otherPlaying) throw Error(`第${otherPlaying.number}枠が体験中です`);
      const summary = this.roundSummary(round.id);
      if (summary.assignedPeople + summary.staffSeats !== 4) throw Error(`通常試合には4名必要です（現在${summary.assignedPeople}名・運営${summary.staffSeats}席）`);
      if (summary.checkedInPeople !== summary.assignedPeople) throw Error(`未入場者がいます（${summary.checkedInPeople}/${summary.assignedPeople}名入場済み）`);
    }
    if (event.type === 'GAME_ENDED' && round.status === 'COMPLETED') {
      this.state.processedGameEvents.push(event.eventId);
      this.state.gameLastSeenAt = this.now();
      if (this.state.processedGameEvents.length > 5000) this.state.processedGameEvents.shift();
      this.persist('late_game_end_accepted', {operator: event.source || 'game-server', roundId: round.id, details: event});
      return {duplicate: false, alreadyCompleted: true, roundId: round.id};
    }
    if (event.type === 'GAME_ENDED' && round.status !== 'PLAYING') throw Error('体験中の枠だけゲームを終了できます');
    if (event.type === 'GAME_RESUMED' && (round.status !== 'PLAYING' || !round.pausedAt)) throw Error('一時停止中の枠だけゲームを再開できます');
    if (event.type === 'GAME_PAUSED' && round.status === 'PLAYING' && round.pausedAt) {
      this.state.processedGameEvents.push(event.eventId);
      this.state.gameLastSeenAt = this.now();
      if (this.state.processedGameEvents.length > 5000) this.state.processedGameEvents.shift();
      this.persist('duplicate_game_pause_accepted', {operator: event.source || 'game-server', roundId: round.id, details: event});
      return {duplicate: false, alreadyPaused: true, roundId: round.id};
    }
    const map = {GAME_STARTED: 'PLAYING', GAME_RESUMED: 'PLAYING', GAME_ENDED: 'COMPLETED'};
    if (event.type === 'GAME_PAUSED') {
      if (round.status !== 'PLAYING') throw Error('体験中の枠だけ一時停止できます');
      // ゲームの一時停止では調整枠を自動で増やさない。遅れが出たときは運営画面で調整枠を追加する。
      round.pausedAt = Number(event.occurredAt) || this.now();
    } else if (event.type === 'EQUIPMENT_TROUBLE') {
      const delay = Math.max(0, Math.min(120, Number(event.delayMinutes) || 0));
      this.state.settings.globalDelayMinutes = Math.min(600, this.state.settings.globalDelayMinutes + Math.ceil(delay / SLOT_MINUTES) * SLOT_MINUTES);
      this.ensureAdjustmentAnchor();
      this.state.globalMessage = event.message ? String(event.message).slice(0, 500) : adjustmentNotice(Math.floor(this.state.settings.globalDelayMinutes / SLOT_MINUTES));
    } else if (map[event.type]) {
      round.status = map[event.type];
      if (round.status === 'PLAYING') { round.activeSlotStartAt ??= round.scheduledAt ?? round.slotStartAt ?? floorSlotBoundary(this.now()); round.startedAt ??= Number(event.occurredAt) || this.now(); round.pausedAt = null; }
      if (round.status === 'COMPLETED') { round.completedAt = Number(event.occurredAt) || this.now(); round.pausedAt = null; }
      for (const id of round.ticketIds) {
        const ticket = this.ticket(id);
        if (ticket && !terminalStates.has(ticket.status)) { ticket.status = round.status; ticket.updatedAt = this.now(); }
      }
    } else throw Error('未知のゲームイベントです');
    this.state.processedGameEvents.push(event.eventId);
    this.state.gameLastSeenAt = this.now();
    if (this.state.processedGameEvents.length > 5000) this.state.processedGameEvents.shift();
    this.scheduleRounds();
    this.withdrawEarlyCalledRound(event.source || 'game-server');
    this.persist('game_event', {operator: event.source || 'game-server', roundId: round.id, details: event});
    if (['GAME_STARTED', 'GAME_ENDED'].includes(event.type)) this.callDueRound('automatic');
    return {duplicate: false, roundId: round.id};
  }
}
