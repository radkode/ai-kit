/**
 * Model registry: metadata, prices, and deprecation routing.
 *
 * Metadata, not an allowlist — an unknown model id still runs (with zero-cost
 * pricing and a telemetry-visible `pricingVersion` of "unknown"), so a newly
 * released model is usable before this table catches up. Deprecated ids route
 * to their replacement so a stale env var never breaks a deploy.
 *
 * Pricing is USD per million tokens, from Anthropic's published rates.
 * PRICING_VERSION is stamped into every run's meta so recorded costs stay
 * auditable as prices change.
 */

export const PRICING_VERSION = '2026-07-30';

export interface ModelInfo {
  id: string;
  provider: 'anthropic';
  /** USD per million input tokens. */
  inputPerMTok: number;
  /** USD per million output tokens. */
  outputPerMTok: number;
  /** Multiplier for cache-read tokens (Anthropic bills ~0.1x input). */
  cachedInputMultiplier: number;
  /** Opus 5 / Sonnet 5 reject the temperature param; the provider layer must omit it. */
  supportsTemperature: boolean;
  deprecated?: boolean;
  replacement?: string;
}

const MODELS: Record<string, ModelInfo> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    provider: 'anthropic',
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputMultiplier: 0.1,
    supportsTemperature: false,
  },
  'claude-opus-4-8': {
    id: 'claude-opus-4-8',
    provider: 'anthropic',
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputMultiplier: 0.1,
    supportsTemperature: false,
  },
  'claude-opus-4-7': {
    id: 'claude-opus-4-7',
    provider: 'anthropic',
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputMultiplier: 0.1,
    supportsTemperature: false,
  },
  'claude-opus-4-6': {
    id: 'claude-opus-4-6',
    provider: 'anthropic',
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    provider: 'anthropic',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputMultiplier: 0.1,
    supportsTemperature: false,
  },
  'claude-sonnet-4-6': {
    id: 'claude-sonnet-4-6',
    provider: 'anthropic',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    provider: 'anthropic',
    inputPerMTok: 1,
    outputPerMTok: 5,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
  },
  // Deprecated ids route forward so stale config keeps working.
  'claude-sonnet-4-5': {
    id: 'claude-sonnet-4-5',
    provider: 'anthropic',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
    deprecated: true,
    replacement: 'claude-sonnet-5',
  },
  'claude-sonnet-4-0': {
    id: 'claude-sonnet-4-0',
    provider: 'anthropic',
    inputPerMTok: 3,
    outputPerMTok: 15,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
    deprecated: true,
    replacement: 'claude-sonnet-5',
  },
  'claude-opus-4-5': {
    id: 'claude-opus-4-5',
    provider: 'anthropic',
    inputPerMTok: 5,
    outputPerMTok: 25,
    cachedInputMultiplier: 0.1,
    supportsTemperature: true,
    deprecated: true,
    replacement: 'claude-opus-5',
  },
};

/**
 * Unknown models are priced at the most expensive known tier. Budgets must
 * fail in the over-estimating direction: pricing an unknown model at zero
 * would silently disable USD enforcement for it.
 */
const UNKNOWN_MODEL_PRICING = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cachedInputMultiplier: 0.1,
} as const;

/** Resolve a model id, following deprecation routing to the replacement. */
export function resolveModel(id: string): ModelInfo {
  const seen = new Set<string>();
  let current = id;
  while (!seen.has(current)) {
    seen.add(current);
    const info = MODELS[current];
    if (!info) break;
    if (info.deprecated && info.replacement) {
      current = info.replacement;
      continue;
    }
    return info;
  }
  const known = MODELS[current];
  if (known) return known;
  return {
    id: current,
    provider: 'anthropic',
    ...UNKNOWN_MODEL_PRICING,
    supportsTemperature: false,
  };
}

export function isKnownModel(id: string): boolean {
  return id in MODELS;
}

/** Multiplier Anthropic bills for writing tokens into the prompt cache (5m TTL). */
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimated cost in USD for a call's usage on a given model. */
export function estimateCostUsd(
  model: ModelInfo,
  usage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens?: number;
  },
): number {
  const cacheWrites = usage.cacheWriteInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - usage.cachedInputTokens - cacheWrites);
  return (
    (uncachedInput * model.inputPerMTok +
      usage.cachedInputTokens * model.inputPerMTok * model.cachedInputMultiplier +
      cacheWrites * model.inputPerMTok * CACHE_WRITE_MULTIPLIER +
      usage.outputTokens * model.outputPerMTok) /
    1_000_000
  );
}
