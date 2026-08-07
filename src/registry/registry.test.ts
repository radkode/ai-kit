import { afterEach, describe, expect, it } from 'vitest';
import { estimateCostUsd, resolveModel } from './models.js';
import { resolveProfile } from './profiles.js';

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
