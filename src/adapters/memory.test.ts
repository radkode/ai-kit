import { describe, expect, it, vi } from 'vitest';
import { memoryBudget, memoryCache } from './memory.js';

describe('memoryCache', () => {
  it('stores, returns, and expires values', async () => {
    const cache = memoryCache();
    await cache.set('k', 'v', 60);
    expect(await cache.get('k')).toBe('v');
    expect(await cache.get('missing')).toBeNull();
  });
});

describe('memoryBudget', () => {
  const limit = { tokens: 1000, usd: 1 };

  it('reserve + settle records spend and releases the remainder', async () => {
    const store = memoryBudget();
    const reservation = await store.reserve('k', { tokens: 600, usd: 0.6 }, limit);
    expect(reservation).not.toBeNull();

    // While reserved, a second reservation that would overshoot is denied.
    expect(await store.reserve('k', { tokens: 600, usd: 0.6 }, limit)).toBeNull();

    await store.settle(reservation!, { tokens: 100, usd: 0.1 });

    // Settling freed the unused 500 tokens: a 600-token reservation now fits
    // against the 100 spent (100 + 600 <= 1000).
    expect(await store.reserve('k', { tokens: 600, usd: 0.6 }, limit)).not.toBeNull();
  });

  it('release drops the reservation without recording spend', async () => {
    const store = memoryBudget();
    const reservation = await store.reserve('k', { tokens: 1000, usd: 1 }, limit);
    await store.release(reservation!);
    expect(await store.reserve('k', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
  });

  it('settle is idempotent per reservation', async () => {
    const store = memoryBudget();
    const reservation = await store.reserve('k', { tokens: 500, usd: 0.5 }, limit);
    await store.settle(reservation!, { tokens: 500, usd: 0.5 });
    await store.settle(reservation!, { tokens: 500, usd: 0.5 });
    // Double-settle must not double-count: 500 spent leaves room for 500 more.
    expect(await store.reserve('k', { tokens: 500, usd: 0.5 }, limit)).not.toBeNull();
  });
});

describe('memoryCache eviction', () => {
  it('overwriting an existing key at capacity does not evict another entry', async () => {
    const { memoryCache } = await import('./memory.js');
    const cache = memoryCache({ maxEntries: 2 });
    await cache.set('a', '1', 60);
    await cache.set('b', '2', 60);
    await cache.set('a', '1b', 60);
    expect(await cache.get('a')).toBe('1b');
    expect(await cache.get('b')).toBe('2');
  });
});

describe('memoryCache expiry and eviction', () => {
  it('drops an expired entry on read rather than serving it', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-01T00:00:00Z'));
      const cache = memoryCache();
      await cache.set('k', 'v', 60);
      expect(await cache.get('k')).toBe('v');

      vi.setSystemTime(new Date('2026-09-01T00:01:01Z'));
      expect(await cache.get('k')).toBeNull();
      // A second read confirms the entry was deleted, not merely masked.
      expect(await cache.get('k')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('evicts the oldest entry when a new key arrives at capacity', async () => {
    const cache = memoryCache({ maxEntries: 2 });
    await cache.set('a', '1', 60);
    await cache.set('b', '2', 60);
    await cache.set('c', '3', 60);

    expect(await cache.get('a')).toBeNull();
    expect(await cache.get('b')).toBe('2');
    expect(await cache.get('c')).toBe('3');
  });
});

describe('memoryBudget ledger isolation', () => {
  const limit = { tokens: 1000, usd: 1 };

  it('meters each key separately, so one tenant cannot consume another headroom', async () => {
    const store = memoryBudget();
    expect(await store.reserve('tenant-a', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
    expect(await store.reserve('tenant-b', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
    expect(await store.reserve('tenant-a', { tokens: 1, usd: 0 }, limit)).toBeNull();
  });

  it('grants a reservation exactly at the limit and denies one unit past it', async () => {
    const store = memoryBudget();
    expect(await store.reserve('k', { tokens: 1000, usd: 1 }, limit)).not.toBeNull();
    expect(await store.reserve('j', { tokens: 1001, usd: 1 }, limit)).toBeNull();
  });

  it('enforces the dollar limit independently of the token limit', async () => {
    const store = memoryBudget();
    expect(await store.reserve('k', { tokens: 1, usd: 2 }, limit)).toBeNull();
    expect(await store.reserve('k', { tokens: 2000, usd: 0.1 }, limit)).toBeNull();
  });

  it('cannot be driven negative by a repeated settle or a stale release', async () => {
    const store = memoryBudget();
    // Settling less than was reserved is the normal case, and the one where a
    // double-applied settle would hand back headroom that was never released.
    const reservation = await store.reserve('k', { tokens: 900, usd: 0.9 }, limit);
    await store.settle(reservation!, { tokens: 100, usd: 0.1 });
    await store.settle(reservation!, { tokens: 100, usd: 0.1 });
    await store.release(reservation!);

    expect(await store.reserve('k', { tokens: 900, usd: 0.9 }, limit)).not.toBeNull();
    expect(await store.reserve('k', { tokens: 1, usd: 0.001 }, limit)).toBeNull();
  });

  it('issues a distinct id per reservation', async () => {
    const store = memoryBudget();
    const ids = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const reservation = await store.reserve('k', { tokens: 1, usd: 0.001 }, limit);
      ids.add(reservation!.id);
    }
    expect(ids.size).toBe(5);
  });
});
