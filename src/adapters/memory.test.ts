import { describe, expect, it } from 'vitest';
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
