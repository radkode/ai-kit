import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, isKnownModel, resolveModel } from './models.js';
import { DEFAULT_PROFILES, profileNames, resolveProfile } from './profiles.js';

describe('resolveModel', () => {
  it('routes deprecated ids to their replacement', () => {
    expect(resolveModel('claude-sonnet-4-0').id).toBe('claude-sonnet-5');
    expect(resolveModel('claude-opus-4-5').id).toBe('claude-opus-5');
  });

  it('passes unknown ids through with conservative (top-tier) pricing', () => {
    const model = resolveModel('some-future-model');
    expect(model.id).toBe('some-future-model');
    expect(model.inputPerMTok).toBeGreaterThan(0);
  });
});

describe('estimateCostUsd', () => {
  it('discounts cached input tokens', () => {
    const haiku = resolveModel('claude-haiku-4-5');
    const uncached = estimateCostUsd(haiku, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    const fullyCached = estimateCostUsd(haiku, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 1_000_000,
    });
    expect(uncached).toBe(1);
    expect(fullyCached).toBeCloseTo(0.1);
  });
});

describe('resolveProfile', () => {
  const ENV_KEY = 'AI_PROFILE_FAST_STRUCTURED';

  afterEach(() => {
    delete process.env[ENV_KEY];
  });

  it('applies env model overrides per profile', () => {
    process.env[ENV_KEY] = 'claude-sonnet-4-6';
    expect(resolveProfile('fast-structured')?.model).toBe('claude-sonnet-4-6');
  });

  it('applies definition overrides on top of the profile', () => {
    const profile = resolveProfile('fast', { maxOutputTokens: 9999 });
    expect(profile?.maxOutputTokens).toBe(9999);
  });

  it('returns undefined for unknown profiles', () => {
    expect(resolveProfile('nope')).toBeUndefined();
  });
});

describe('unknown model pricing', () => {
  it('prices unknown models conservatively, never at zero', () => {
    const model = resolveModel('some-future-model');
    const cost = estimateCostUsd(model, {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cost).toBeGreaterThan(0);
  });

  it('never under-prices against the most expensive known model', () => {
    const unknown = resolveModel('some-future-model');
    const priciest = resolveModel('claude-fable-5');
    expect(unknown.inputPerMTok).toBeGreaterThanOrEqual(priciest.inputPerMTok);
    expect(unknown.outputPerMTok).toBeGreaterThanOrEqual(priciest.outputPerMTok);
  });
});

describe('isKnownModel', () => {
  it('reports table membership, which includes ids resolveModel routes away from', () => {
    expect(isKnownModel('claude-haiku-4-5')).toBe(true);
    expect(isKnownModel('some-future-model')).toBe(false);
    // A deprecated id is in the table even though resolveModel forwards it.
    expect(isKnownModel('claude-sonnet-4-0')).toBe(true);
    expect(resolveModel('claude-sonnet-4-0').id).not.toBe('claude-sonnet-4-0');
  });
});

describe('deprecation routing', () => {
  const DEPRECATED = ['claude-sonnet-4-5', 'claude-sonnet-4-0', 'claude-opus-4-5'];

  it('lands on a live model in one hop and stays there', () => {
    for (const id of DEPRECATED) {
      const resolved = resolveModel(id);
      expect(resolved.deprecated, id).toBeFalsy();
      // Idempotent: routing a resolved id again cannot move it or loop.
      expect(resolveModel(resolved.id).id, id).toBe(resolved.id);
    }
  });

  it('prices a deprecated id at its replacement rate, not its own', () => {
    const routed = resolveModel('claude-opus-4-5');
    expect(routed.id).toBe('claude-opus-5');
    expect(routed).toEqual(resolveModel('claude-opus-5'));
  });
});

describe('estimateCostUsd pricing directions', () => {
  const model = resolveModel('claude-haiku-4-5');
  const TOKENS = 1_000_000;

  it('prices output independently of input', () => {
    const outputOnly = estimateCostUsd(model, {
      inputTokens: 0,
      outputTokens: TOKENS,
      cachedInputTokens: 0,
    });
    expect(outputOnly).toBe(model.outputPerMTok);
  });

  it('surcharges cache writes and discounts cache reads', () => {
    const write = estimateCostUsd(model, {
      inputTokens: TOKENS,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: TOKENS,
    });
    const uncached = estimateCostUsd(model, {
      inputTokens: TOKENS,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    const read = estimateCostUsd(model, {
      inputTokens: TOKENS,
      outputTokens: 0,
      cachedInputTokens: TOKENS,
    });

    // A sign error anywhere here silently misprices every cached run.
    expect(write).toBeGreaterThan(uncached);
    expect(uncached).toBeGreaterThan(read);
    expect(write).toBeCloseTo(uncached * 1.25);
  });

  it('never returns a negative cost, even on over-reported cache counts', () => {
    const cost = estimateCostUsd(model, {
      inputTokens: 100,
      outputTokens: 0,
      cachedInputTokens: 900,
      cacheWriteInputTokens: 900,
    });
    expect(cost).toBeGreaterThanOrEqual(0);
  });

  it('defaults cacheWriteInputTokens to zero and charges nothing for zero usage', () => {
    const withoutField = estimateCostUsd(model, {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    const withZero = estimateCostUsd(model, {
      inputTokens: 1000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
    expect(withoutField).toBe(withZero);
    expect(
      estimateCostUsd(model, { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }),
    ).toBe(0);
  });
});

describe('profile registry integrity', () => {
  it('lists exactly the profiles it can resolve', () => {
    const names = profileNames();
    expect(names).toEqual(Object.keys(DEFAULT_PROFILES));
    for (const name of names) expect(resolveProfile(name), name).toBeDefined();
  });

  it('holds internally consistent entries, so a typo fails here not at run time', () => {
    for (const [key, profile] of Object.entries(DEFAULT_PROFILES)) {
      expect(profile.name, key).toBe(key);
      expect(resolveModel(profile.model).id, key).toBeTruthy();
      expect(profile.maxOutputTokens, key).toBeGreaterThan(0);
      expect(profile.timeoutMs, key).toBeGreaterThan(0);
      expect(profile.maxRetries, key).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('resolveProfile env overrides', () => {
  const KEYS = ['AI_PROFILE_FAST', 'AI_PROFILE_FAST_STRUCTURED', 'AI_PROFILE_DEEP'];

  afterEach(() => {
    for (const key of KEYS) delete process.env[key];
  });

  it('derives the env key by uppercasing and replacing hyphens', () => {
    process.env.AI_PROFILE_FAST_STRUCTURED = 'model-a';
    process.env.AI_PROFILE_DEEP = 'model-b';
    expect(resolveProfile('fast-structured')?.model).toBe('model-a');
    expect(resolveProfile('deep')?.model).toBe('model-b');
  });

  it('leaves sibling profiles alone', () => {
    process.env.AI_PROFILE_FAST = 'model-a';
    expect(resolveProfile('fast')?.model).toBe('model-a');
    expect(resolveProfile('fast-structured')?.model).toBe(
      DEFAULT_PROFILES['fast-structured']!.model,
    );
  });

  it('ignores an empty override rather than resolving an empty model id', () => {
    process.env.AI_PROFILE_FAST = '';
    expect(resolveProfile('fast')?.model).toBe(DEFAULT_PROFILES['fast']!.model);
  });
});

describe('resolveProfile isolation', () => {
  it('returns a fresh object and never mutates the shared defaults', () => {
    const before = { ...DEFAULT_PROFILES['fast']! };
    const tuned = resolveProfile('fast', { maxOutputTokens: 9999, temperature: 0.99 });

    expect(tuned).not.toBe(DEFAULT_PROFILES['fast']);
    // Mutating the shared table would silently reconfigure every task in the process.
    expect(DEFAULT_PROFILES['fast']).toEqual(before);
    expect(tuned?.maxOutputTokens).toBe(9999);
  });

  it('applies only the override keys supplied', () => {
    const base = DEFAULT_PROFILES['fast']!;
    expect(resolveProfile('fast', {})).toEqual(base);
    expect(resolveProfile('fast', { timeoutMs: 1 })).toEqual({ ...base, timeoutMs: 1 });
    expect(
      resolveProfile('fast', {
        temperature: 0.1,
        maxOutputTokens: 2,
        timeoutMs: 3,
        maxRetries: 4,
      }),
    ).toEqual({ ...base, temperature: 0.1, maxOutputTokens: 2, timeoutMs: 3, maxRetries: 4 });
  });
});
