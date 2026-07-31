import { randomUUID } from 'node:crypto';
import { Redis } from '@upstash/redis';
import type { AiBudgetStore, AiCache, BudgetReservation } from '../core/contracts.js';

/**
 * Production adapters backed by Upstash Redis (HTTP client, serverless-safe).
 *
 * Budget accounting is implemented as three Lua scripts so every operation is
 * ATOMIC (no partial application across commands), IDEMPOTENT (retried or
 * duplicated deliveries over Upstash's at-least-once HTTP transport cannot
 * double-apply), and SELF-HEALING (reservations live as entries in a hash with
 * a timestamp; the reserve script sweeps entries older than `staleMs`, so a
 * crashed process's leaked reservation frees itself without a background job).
 *
 * Reserved headroom is DERIVED by summing live reservation entries rather than
 * kept as a counter, which makes drift (negative counters, phantom headroom)
 * structurally impossible: a reservation either exists in the hash or it
 * does not.
 */

const USD_SCALE = 1_000_000; // store USD as integer micro-dollars

export function upstashCache(redis: Redis, options: { prefix?: string } = {}): AiCache {
  const prefix = options.prefix ?? 'aikit:cache:';
  return {
    async get(key) {
      const raw = await redis.get(prefix + key);
      if (raw === null || raw === undefined) return null;
      // The client's automaticDeserialization may hand back a parsed object
      // for values that look like JSON; the AiCache contract is strings.
      return typeof raw === 'string' ? raw : JSON.stringify(raw);
    },
    async set(key, value, ttlSeconds) {
      await redis.set(prefix + key, value, { ex: ttlSeconds });
    },
  };
}

// KEYS[1]=resv hash, KEYS[2]=spent:tok, KEYS[3]=spent:usd
// ARGV: id, tokens, usdMicro, limitTok, limitUsdMicro, nowMs, staleMs, ttlSec
// Returns 1 when granted, 0 when the limit would be exceeded.
const RESERVE_SCRIPT = `
local resv = KEYS[1]
local id = ARGV[1]
local tokens = tonumber(ARGV[2])
local usd = tonumber(ARGV[3])
local limitTok = tonumber(ARGV[4])
local limitUsd = tonumber(ARGV[5])
local now = tonumber(ARGV[6])
local staleMs = tonumber(ARGV[7])
local ttl = tonumber(ARGV[8])

local sumTok = 0
local sumUsd = 0
local entries = redis.call('HGETALL', resv)
for i = 1, #entries, 2 do
  local field = entries[i]
  local tok, u, ts = string.match(entries[i + 1], '^(%d+):(%d+):(%d+)$')
  if tok == nil or (now - tonumber(ts)) > staleMs then
    redis.call('HDEL', resv, field)
  else
    sumTok = sumTok + tonumber(tok)
    sumUsd = sumUsd + tonumber(u)
  end
end

local spentTok = tonumber(redis.call('GET', KEYS[2]) or '0')
local spentUsd = tonumber(redis.call('GET', KEYS[3]) or '0')

if (sumTok + spentTok + tokens) > limitTok or (sumUsd + spentUsd + usd) > limitUsd then
  return 0
end

redis.call('HSET', resv, id, tokens .. ':' .. usd .. ':' .. now)
redis.call('EXPIRE', resv, ttl)
return 1
`;

// KEYS[1]=resv hash, KEYS[2]=spent:tok, KEYS[3]=spent:usd
// ARGV: id, actualTok, actualUsdMicro, ttlSec
// Spend is recorded only when this call is the one that removed the
// reservation entry, which is what makes retried settles no-ops.
const SETTLE_SCRIPT = `
local removed = redis.call('HDEL', KEYS[1], ARGV[1])
if removed == 1 then
  redis.call('INCRBY', KEYS[2], tonumber(ARGV[2]))
  redis.call('INCRBY', KEYS[3], tonumber(ARGV[3]))
  redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4]))
  redis.call('EXPIRE', KEYS[3], tonumber(ARGV[4]))
end
return removed
`;

const RELEASE_SCRIPT = `
return redis.call('HDEL', KEYS[1], ARGV[1])
`;

export interface UpstashBudgetOptions {
  prefix?: string;
  /** TTL on all budget keys; default a little past a monthly period. */
  keyTtlSeconds?: number;
  /** Reservations older than this are swept as leaked; default 15 minutes. */
  reservationStaleMs?: number;
}

export function upstashBudget(redis: Redis, options: UpstashBudgetOptions = {}): AiBudgetStore {
  const prefix = options.prefix ?? 'aikit:budget:';
  const keyTtl = options.keyTtlSeconds ?? 40 * 24 * 3600;
  const staleMs = options.reservationStaleMs ?? 15 * 60 * 1000;

  const keys = (key: string): [string, string, string] => [
    `${prefix}${key}:resv`,
    `${prefix}${key}:s:tok`,
    `${prefix}${key}:s:usd`,
  ];

  return {
    async reserve(key, amount, limit) {
      const id = randomUUID();
      const granted = await redis.eval(
        RESERVE_SCRIPT,
        keys(key),
        [
          id,
          Math.ceil(amount.tokens),
          Math.ceil(amount.usd * USD_SCALE),
          Math.floor(limit.tokens),
          Math.floor(limit.usd * USD_SCALE),
          Date.now(),
          staleMs,
          keyTtl,
        ],
      );
      if (Number(granted) !== 1) return null;
      return { id, key, reserved: amount };
    },

    async settle(reservation: BudgetReservation, actual) {
      await redis.eval(
        SETTLE_SCRIPT,
        keys(reservation.key),
        [
          reservation.id,
          Math.ceil(actual.tokens),
          Math.ceil(actual.usd * USD_SCALE),
          keyTtl,
        ],
      );
    },

    async release(reservation: BudgetReservation) {
      await redis.eval(RELEASE_SCRIPT, [keys(reservation.key)[0]], [reservation.id]);
    },
  };
}
