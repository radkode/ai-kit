import { describe, expect, it } from 'vitest';
import { runCacheKey, stableStringify } from './hash.js';

describe('stableStringify', () => {
  it('is key-order independent', () => {
    expect(stableStringify({ a: 1, b: 2 })).toBe(stableStringify({ b: 2, a: 1 }));
  });

  it('distinguishes Dates, Maps, and Sets instead of collapsing them to {}', () => {
    const d1 = stableStringify({ at: new Date('2026-01-01T00:00:00Z') });
    const d2 = stableStringify({ at: new Date('2026-06-01T00:00:00Z') });
    expect(d1).not.toBe(d2);

    const m1 = stableStringify(new Map([['a', 1]]));
    const m2 = stableStringify(new Map([['a', 2]]));
    expect(m1).not.toBe(m2);

    const s1 = stableStringify(new Set([1, 2]));
    const s2 = stableStringify(new Set([1, 3]));
    expect(s1).not.toBe(s2);
    expect(stableStringify(new Set([2, 1]))).toBe(s1);
  });
});

describe('stableStringify structure', () => {
  it('sorts keys at every depth, not just the top level', () => {
    const a = stableStringify({ outer: { b: 1, a: 2 }, top: 3 });
    const b = stableStringify({ top: 3, outer: { a: 2, b: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"a":2,"b":1},"top":3}');
  });

  it('preserves array order, since order is meaningful in a list', () => {
    expect(stableStringify([1, 2, 3])).not.toBe(stableStringify([3, 2, 1]));
  });

  it('is insensitive to Map and Set insertion order', () => {
    const forward = stableStringify(new Map([['a', 1], ['b', 2]]));
    const reversed = stableStringify(new Map([['b', 2], ['a', 1]]));
    expect(forward).toBe(reversed);
    expect(stableStringify(new Set(['x', 'y']))).toBe(stableStringify(new Set(['y', 'x'])));
  });

  it('keeps a Map, an object, a Set, and an array from colliding', () => {
    // Plain JSON.stringify collapses Map and Set to {}, which would make
    // structurally different inputs share a cache key.
    expect(stableStringify(new Map([['a', 1]]))).not.toBe(stableStringify({ a: 1 }));
    expect(stableStringify(new Set([1, 2]))).not.toBe(stableStringify([1, 2]));
  });

  it('represents a Date by its instant, so equal Dates collide and others do not', () => {
    const iso = '2026-01-01T00:00:00.000Z';
    expect(stableStringify(new Date(iso))).toBe(stableStringify(new Date(iso)));
    expect(stableStringify(new Date(iso))).toContain(iso);
    expect(stableStringify(new Date(iso))).not.toBe(
      stableStringify(new Date('2026-01-02T00:00:00.000Z')),
    );
  });

  it('handles nested collections and primitives without losing them', () => {
    const value = { m: new Map([['k', new Set([2, 1])]]), d: new Date(0), n: null, s: 'x' };
    expect(stableStringify(value)).toBe(
      '{"d":{"$date":"1970-01-01T00:00:00.000Z"},"m":{"$map":[["k",{"$set":[1,2]}]]},"n":null,"s":"x"}',
    );
  });

  it('treats an explicitly undefined property as absent, but keeps null distinct', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
    expect(stableStringify({ a: 1, b: null })).not.toBe(stableStringify({ a: 1 }));
  });
});

describe('runCacheKey', () => {
  const base = {
    taskId: 'demo.capture-triage',
    taskVersion: '1',
    model: 'claude-haiku-4-5',
    input: { captureText: 'call the vendor' } as unknown,
    tenantId: 'tenant-a' as string | undefined,
    capabilities: { tools: false, web: false } as unknown,
    renderData: { userTimezone: 'UTC' } as unknown,
  };

  it('is stable and shaped as a namespaced sha256', () => {
    expect(runCacheKey(base)).toBe(runCacheKey({ ...base }));
    expect(runCacheKey(base)).toMatch(/^aikit:demo\.capture-triage:[0-9a-f]{64}$/);
  });

  it('changes when any participating field changes', () => {
    const variants = [
      { ...base, taskId: 'demo.other' },
      { ...base, taskVersion: '2' },
      { ...base, model: 'claude-sonnet-5' },
      { ...base, input: { captureText: 'call the other vendor' } },
      { ...base, tenantId: 'tenant-b' },
      { ...base, capabilities: { tools: false, web: true } },
      { ...base, renderData: { userTimezone: 'Europe/Warsaw' } },
    ];
    const keys = new Set([runCacheKey(base), ...variants.map(runCacheKey)]);
    expect(keys.size).toBe(variants.length + 1);
  });

  it('makes a cross-tenant hit structurally impossible', () => {
    // Tenancy is inside the digest, not merely a prefix a caller could forget.
    expect(runCacheKey({ ...base, tenantId: 'tenant-a' })).not.toBe(
      runCacheKey({ ...base, tenantId: 'tenant-b' }),
    );
    expect(runCacheKey({ ...base, tenantId: undefined })).not.toBe(runCacheKey(base));
    expect(runCacheKey({ ...base, tenantId: undefined })).toBe(
      runCacheKey({ ...base, tenantId: undefined }),
    );
  });

  it('ignores the key order of the caller input object', () => {
    expect(runCacheKey({ ...base, input: { a: 1, b: 2 } })).toBe(
      runCacheKey({ ...base, input: { b: 2, a: 1 } }),
    );
  });
});

describe('stableStringify ordering edge cases', () => {
  it('orders a Set holding unstringifiable and duplicate-ordering members', () => {
    // JSON.stringify(undefined) is undefined, so the comparator needs a fallback.
    expect(stableStringify(new Set([undefined, 'a']))).toBe(
      stableStringify(new Set(['a', undefined])),
    );
    // Members that compare equal must not make the sort unstable.
    expect(stableStringify(new Map([['a', 1], ['a', 2]]))).toBe('{"$map":[["a",2]]}');
  });
});

describe('runCacheKey optional parts', () => {
  it('accepts absent capabilities and render data without collapsing them together', () => {
    const base = {
      taskId: 'demo.t',
      taskVersion: '1',
      model: 'm',
      input: { a: 1 } as unknown,
      tenantId: undefined,
      capabilities: undefined,
      renderData: undefined,
    };
    expect(runCacheKey(base)).toMatch(/^aikit:demo\.t:[0-9a-f]{64}$/);
    expect(runCacheKey(base)).not.toBe(runCacheKey({ ...base, capabilities: { tools: true } }));
    expect(runCacheKey(base)).not.toBe(runCacheKey({ ...base, renderData: { tz: 'UTC' } }));
  });
});
