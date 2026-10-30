import {randomBytes, randomUUID} from 'node:crypto';

// 試合結果のSNS共有ページ。結果は整理券の状態と一緒に保存し、7日後に削除する。
// 1人ごとに推測できないトークンを発行し、そのページでは本人の名前だけを表示する。
export const SHARE_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_SHARES = 500;
const count = (value) => Number.isSafeInteger(value) && value >= 0 && value <= 100_000 ? value : 0;

function prune(queue) {
  const now = queue.now();
  queue.state.shares = (queue.state.shares ?? []).filter((item) => item.expiresAt > now).slice(-MAX_SHARES);
}

export function createShare(queue, input) {
  const gameId = String(input?.gameId ?? '').slice(0, 80);
  if (!gameId) throw Error('試合IDがありません');
  if (!Array.isArray(input.players) || input.players.length < 1 || input.players.length > 4) throw Error('参加者は1〜4名です');
  prune(queue);
  const existing = queue.state.shares.find((item) => item.gameId === gameId);
  if (existing) return existing;
  const slots = new Set();
  const players = input.players.map((player) => {
    const slot = Number(player?.slot);
    if (!Number.isInteger(slot) || slot < 1 || slot > 4 || slots.has(slot)) throw Error('プレイヤー番号が不正です');
    slots.add(slot);
    const name = String(player.name ?? '').trim().slice(0, 20) || `プレイヤー${slot}`;
    return {
      slot, name, rank: Math.min(4, Math.max(1, count(player.rank) || 1)),
      kills: count(player.kills), deaths: count(player.deaths), shots: count(player.shots),
      accuracy: Math.min(100, Math.max(0, Number(player.accuracy) || 0)),
      retired: player.retired === true, winner: player.winner === true,
      token: randomBytes(18).toString('base64url'),
    };
  });
  const record = {
    id: randomUUID(), gameId, createdAt: queue.now(), expiresAt: queue.now() + SHARE_TTL_MS,
    rounds: Math.min(9, Math.max(1, count(input.rounds) || 1)), draw: input.draw === true, players,
  };
  queue.state.shares.push(record);
  // 名前は状態にだけ保存し、操作履歴には残さない。
  queue.persist('share_created', {details: {gameId, players: players.length}});
  return record;
}

export function publicShare(queue, token) {
  if (typeof token !== 'string' || !/^[\w-]{20,40}$/.test(token)) return null;
  const record = (queue.state.shares ?? []).find((item) => item.expiresAt > queue.now() && item.players.some((player) => player.token === token));
  if (!record) return null;
  const me = record.players.find((player) => player.token === token);
  return {
    rounds: record.rounds, draw: record.draw, createdAt: record.createdAt, expiresAt: record.expiresAt, me: me.slot,
    players: record.players.map(({token: _token, name, ...player}) => ({...player, name: player.slot === me.slot ? name : `プレイヤー${player.slot}`})),
  };
}
