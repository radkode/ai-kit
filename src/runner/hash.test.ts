import { describe, expect, it } from 'vitest';
import { stableStringify } from './hash.js';

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
