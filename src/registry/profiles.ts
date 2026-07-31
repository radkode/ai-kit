/**
 * Named execution profiles replace per-call-site magic numbers. A call site
 * says `profile: 'fast-structured'`; the profile is the only place model,
 * temperature, token ceilings, and timeouts live. Apps map subscription tier
 * to profile in exactly one file on their side.
 *
 * Every profile's model is env-overridable (AI_PROFILE_FAST=..., etc.) so an
 * app or environment can retier without a code change.
 */

export interface Profile {
  name: string;
  model: string;
  /** Applied only when the resolved model supports it. */
  temperature?: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_PROFILES: Record<string, Profile> = {
  fast: {
    name: 'fast',
    model: 'claude-haiku-4-5',
    temperature: 0.3,
    maxOutputTokens: 1024,
    timeoutMs: 30_000,
    maxRetries: 2,
  },
  'fast-structured': {
    name: 'fast-structured',
    model: 'claude-haiku-4-5',
    temperature: 0.1,
    maxOutputTokens: 2048,
    timeoutMs: 30_000,
    maxRetries: 2,
  },
  balanced: {
    name: 'balanced',
    model: 'claude-sonnet-5',
    maxOutputTokens: 4096,
    timeoutMs: 60_000,
    maxRetries: 2,
  },
  creative: {
    name: 'creative',
    model: 'claude-sonnet-5',
    temperature: 0.8,
    maxOutputTokens: 2048,
    timeoutMs: 60_000,
    maxRetries: 2,
  },
  deep: {
    name: 'deep',
    model: 'claude-opus-5',
    maxOutputTokens: 16_000,
    timeoutMs: 300_000,
    maxRetries: 2,
  },
};

const ENV_PREFIX = 'AI_PROFILE_';

function envKeyFor(profileName: string): string {
  return ENV_PREFIX + profileName.toUpperCase().replace(/-/g, '_');
}

/**
 * Resolve a profile by name, applying the env-var model override if present.
 * Unknown profile names throw at the call site via the runner (AiConfigError),
 * not here, so this stays a pure lookup.
 */
export function resolveProfile(
  name: string,
  overrides?: Partial<Pick<Profile, 'temperature' | 'maxOutputTokens' | 'timeoutMs' | 'maxRetries'>>,
): Profile | undefined {
  const base = DEFAULT_PROFILES[name];
  if (!base) return undefined;
  const envModel = typeof process !== 'undefined' ? process.env[envKeyFor(name)] : undefined;
  const profile: Profile = { ...base, ...(envModel ? { model: envModel } : {}) };
  if (overrides) {
    if (overrides.temperature !== undefined) profile.temperature = overrides.temperature;
    if (overrides.maxOutputTokens !== undefined) profile.maxOutputTokens = overrides.maxOutputTokens;
    if (overrides.timeoutMs !== undefined) profile.timeoutMs = overrides.timeoutMs;
    if (overrides.maxRetries !== undefined) profile.maxRetries = overrides.maxRetries;
  }
  return profile;
}

export function profileNames(): string[] {
  return Object.keys(DEFAULT_PROFILES);
}
