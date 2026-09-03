import type { Redis } from '@upstash/redis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeRedis, type FakeRedis } from '../__fixtures__/fake-redis.js';
import { upstashBudget, upstashCache } from './upstash.js';

let fake: FakeRedis;
const asRedis = () => fake as unknown as Redis;

beforeEach(() => {
  fake = createFakeRedis();
});

afterEach(() => {
  fake.close();
});

describe('upstashCache', () => {
  it('namespaces keys under a default prefix an option can override', async () => {
    const cache = upstashCache(asRedis());
    await cache.set('k', 'v', 60);
    expect(fake.strings().get('aikit:cache:k')).toBe('v');
    expect(await cache.get('k')).toBe('v');

    const custom = upstashCache(asRedis(), { prefix: 'other:' });
    await custom.set('k', 'w', 60);
    expect(fake.strings().get('other:k')).toBe('w');
    // Distinct prefixes must not see each other's entries.
    expect(await cache.get('k')).toBe('v');
  });

  it('passes the TTL through as an expiry rather than writing a durable key', async () => {
    const cache = upstashCache(asRedis());
    await cache.set('k', 'v', 300);
    const set = fake.commands().find((c) => c[0] === 'SET');
    expect(set?.[3]).toBe(JSON.stringify({ ex: 300 }));
  });

  it('reports both null and undefined from the client as a miss', async () => {
    const cache = upstashCache(asRedis());
    expect(await cache.get('never-written')).toBeNull();
    fake.seedRaw('aikit:cache:explicit-undefined', undefined);
    expect(await cache.get('explicit-undefined')).toBeNull();
  });

  it('re-serializes a value the client deserialized, so the string contract holds', async () => {
    const cache = upstashCache(asRedis());
    const stored = { title: 'Email the vendor', priority: 'high' };
    fake.seedRaw('aikit:cache:k', stored);

    const raw = await cache.get('k');
    expect(typeof raw).toBe('string');
    // The runner JSON.parses whatever get() returns, so the round trip must survive.
    expect(JSON.parse(raw!)).toEqual(stored);
  });

  it('leaves an already-string value untouched', async () => {
    const cache = upstashCache(asRedis());
    fake.seedRaw('aikit:cache:k', '{"already":"json"}');
    expect(await cache.get('k')).toBe('{"already":"json"}');
  });
});

describe('upstashBudget', () => {
  const KEY = 'tenant:t1:ai:2026-09';
  const RESV = `aikit:budget:${KEY}:resv`;
  const limit = { tokens: 1000, usd: 1 };

  it('grants a reservation inside the limit and reports the unrounded amount back', async () => {
    const store = upstashBudget(asRedis());
    const amount = { tokens: 250.4, usd: 0.0125 };
    const reservation = await store.reserve(KEY, amount, limit);

    expect(reservation).not.toBeNull();
    expect(reservation!.key).toBe(KEY);
    expect(reservation!.id).toMatch(/^[0-9a-f-]{36}$/);
    // settle() and release() subtract reserved from the caller's ledger, so the
    // reservation must carry the original amount, not the rounded wire value.
    expect(reservation!.reserved).toEqual(amount);
  });

  it('sums live reservations, so concurrent fan-out cannot overspend', async () => {
    const store = upstashBudget(asRedis());
    expect(await store.reserve(KEY, { tokens: 600, usd: 0.1 }, limit)).not.toBeNull();
    expect(await store.reserve(KEY, { tokens: 300, usd: 0.1 }, limit)).not.toBeNull();
    expect(await store.reserve(KEY, { tokens: 200, usd: 0.1 }, limit)).toBeNull();
  });

  it('grants a reservation exactly at the limit and denies one token past it', async () => {
    const store = upstashBudget(asRedis());
    expect(await store.reserve(KEY, { tokens: 1000, usd: 1 }, limit)).not.toBeNull();

    const fresh = upstashBudget(asRedis());
    expect(await fresh.reserve('other', { tokens: 1001, usd: 1 }, limit)).toBeNull();
  });

  it('enforces the dollar limit independently of the token limit', async () => {
    const store = upstashBudget(asRedis());
    const denied = await store.reserve(
      KEY,
      { tokens: 1, usd: 0.5 },
      { tokens: 1_000_000, usd: 0.01 },
    );
    expect(denied).toBeNull();

    const granted = await store.reserve(
      KEY,
      { tokens: 900_000, usd: 0.001 },
      { tokens: 1_000_000, usd: 0.01 },
    );
    expect(granted).not.toBeNull();
  });

  it('rounds spend up and limits down, so rounding can never permit an overspend', async () => {
    const store = upstashBudget(asRedis());
    // 0.4 micro-dollars of spend must not floor to zero and become free.
    const denied = await store.reserve(
      KEY,
      { tokens: 1, usd: 0.0000004 },
      { tokens: 100, usd: 0 },
    );
    expect(denied).toBeNull();

    // A limit of 1.5 micro-dollars floors to 1, so 2 micro-dollars overshoots.
    const overshoot = await store.reserve(
      KEY,
      { tokens: 1, usd: 0.000002 },
      { tokens: 100, usd: 0.0000015 },
    );
    expect(overshoot).toBeNull();

    const fits = await store.reserve(KEY, { tokens: 1, usd: 0.000001 }, { tokens: 100, usd: 0.0000015 });
    expect(fits).not.toBeNull();
  });

  it('settles actual spend and returns the unused remainder of the reservation', async () => {
    const store = upstashBudget(asRedis());
    const reservation = await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit);
    await store.settle(reservation!, { tokens: 100, usd: 0.1 });

    expect(fake.hash(RESV).size).toBe(0);
    expect(fake.strings().get(`aikit:budget:${KEY}:s:tok`)).toBe('100');
    expect(fake.strings().get(`aikit:budget:${KEY}:s:usd`)).toBe('100000');
    // 100 spent leaves room for 900, and not for 901.
    expect(await store.reserve(KEY, { tokens: 900, usd: 0.1 }, limit)).not.toBeNull();
  });

  it('records spend once when the same settle is delivered twice', async () => {
    const store = upstashBudget(asRedis());
    const reservation = await store.reserve(KEY, { tokens: 500, usd: 0.5 }, limit);
    await store.settle(reservation!, { tokens: 500, usd: 0.5 });
    await store.settle(reservation!, { tokens: 500, usd: 0.5 });

    // A double-applied settle would leave 1000 spent and deny this.
    expect(fake.strings().get(`aikit:budget:${KEY}:s:tok`)).toBe('500');
    expect(await store.reserve(KEY, { tokens: 500, usd: 0.5 }, limit)).not.toBeNull();
  });

  it('releases headroom without recording spend', async () => {
    const store = upstashBudget(asRedis());
    const reservation = await store.reserve(KEY, { tokens: 1000, usd: 1 }, limit);
    await store.release(reservation!);

    expect(fake.hash(RESV).size).toBe(0);
    expect(fake.strings().get(`aikit:budget:${KEY}:s:tok`)).toBeUndefined();
    expect(await store.reserve(KEY, { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
  });

  it('treats releasing an unknown or already-released reservation as a no-op', async () => {
    const store = upstashBudget(asRedis());
    const reservation = await store.reserve(KEY, { tokens: 400, usd: 0.4 }, limit);
    await store.release(reservation!);
    await expect(store.release(reservation!)).resolves.toBeUndefined();
    await expect(
      store.release({ id: 'never-existed', key: KEY, reserved: { tokens: 400, usd: 0.4 } }),
    ).resolves.toBeUndefined();
    expect(await store.reserve(KEY, { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
  });

  it('settling an unknown reservation records nothing', async () => {
    const store = upstashBudget(asRedis());
    await store.settle(
      { id: 'never-existed', key: KEY, reserved: { tokens: 10, usd: 0.1 } },
      { tokens: 10, usd: 0.1 },
    );
    expect(fake.strings().get(`aikit:budget:${KEY}:s:tok`)).toBeUndefined();
  });

  it('touches only the reservation hash on release, never the spend counters', async () => {
    const store = upstashBudget(asRedis());
    const reservation = await store.reserve(KEY, { tokens: 10, usd: 0.1 }, limit);
    const before = fake.commands().length;
    await store.release(reservation!);
    const during = fake.commands().slice(before);
    expect(during).toEqual([['HDEL', RESV, reservation!.id]]);
  });

  it('derives its three keys from the prefix and the caller key', async () => {
    const store = upstashBudget(asRedis(), { prefix: 'custom:' });
    const reservation = await store.reserve('k', { tokens: 10, usd: 0.1 }, limit);
    await store.settle(reservation!, { tokens: 10, usd: 0.1 });
    expect([...fake.strings().keys()].sort()).toEqual(['custom:k:s:tok', 'custom:k:s:usd']);
    expect(fake.hash('custom:k:resv')).toBeDefined();
  });

  it('keeps ledgers separate per key, so one tenant cannot consume another headroom', async () => {
    const store = upstashBudget(asRedis());
    expect(await store.reserve('tenant-a', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
    expect(await store.reserve('tenant-b', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
  });

  it('deletes a corrupt reservation entry instead of trusting or crashing on it', async () => {
    const store = upstashBudget(asRedis());
    await store.reserve(KEY, { tokens: 10, usd: 0.1 }, limit);
    fake.hash(RESV).set('garbage', 'not:a:valid:triplet');

    expect(await store.reserve(KEY, { tokens: 900, usd: 0.5 }, limit)).not.toBeNull();
    expect(fake.hash(RESV).has('garbage')).toBe(false);
  });
});

describe('upstashBudget stale reservation sweep', () => {
  const KEY = 'k';
  const RESV = 'aikit:budget:k:resv';
  const limit = { tokens: 1000, usd: 1 };

  beforeEach(() => {
    // Only Date is faked; wasm promise resolution still needs real timers.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reclaims a reservation a crashed process left behind', async () => {
    const store = upstashBudget(asRedis(), { reservationStaleMs: 60_000 });
    const leaked = await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit);
    expect(leaked).not.toBeNull();

    vi.setSystemTime(new Date('2026-09-01T00:02:00Z'));
    const after = await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit);

    expect(after).not.toBeNull();
    expect([...fake.hash(RESV).keys()]).toEqual([after!.id]);
  });

  it('still counts a reservation that has not yet gone stale', async () => {
    const store = upstashBudget(asRedis(), { reservationStaleMs: 60_000 });
    await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit);

    vi.setSystemTime(new Date('2026-09-01T00:00:30Z'));
    expect(await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit)).toBeNull();
  });

  it('defaults to a fifteen minute staleness window', async () => {
    const store = upstashBudget(asRedis());
    await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit);

    vi.setSystemTime(new Date('2026-09-01T00:14:00Z'));
    expect(await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit)).toBeNull();

    vi.setSystemTime(new Date('2026-09-01T00:16:00Z'));
    expect(await store.reserve(KEY, { tokens: 900, usd: 0.9 }, limit)).not.toBeNull();
  });
});
