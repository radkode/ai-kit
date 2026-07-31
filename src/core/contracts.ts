/**
 * The contracts every other module builds on. This file has no dependencies;
 * apps and adapters implement these interfaces, the runner consumes them.
 */

/** Token usage for one provider call, normalized across providers. */
export interface AiUsage {
  inputTokens: number;
  outputTokens: number;
  /** Tokens served from the provider's prompt cache (billed at a discount). */
  cachedInputTokens: number;
  /** Tokens written to the provider's prompt cache (billed at a surcharge). */
  cacheWriteInputTokens: number;
}

/** Provenance for one run. Persisting this verbatim next to the output is the norm. */
export interface AiRunMeta {
  taskId: string;
  taskVersion: string;
  provider: string;
  model: string;
  profile: string;
  usage: AiUsage;
  /** Estimated cost in USD, from the registry's pricing table. */
  costUsd: number;
  /** Which pricing table computed costUsd, so recorded costs stay auditable. */
  pricingVersion: string;
  latencyMs: number;
  cached: boolean;
  /**
   * How the output was recovered when the first response failed validation:
   * 'salvage' = free re-parse of the raw text; 'repair' = one paid corrective
   * call. Absent when the first response validated cleanly.
   */
  recovery?: 'salvage' | 'repair';
  /** Set when a declared fallback profile served the request. */
  fallbackProfile?: string;
}

export interface AiRunResult<Out> {
  output: Out;
  meta: AiRunMeta;
}

/** What the executing surface can do; feeds capability-conditional instructions. */
export interface Capabilities {
  /** Can the agent call tools during this task? */
  tools: boolean;
  /** Does the agent have live web access? */
  web: boolean;
}

export const DEFAULT_CAPABILITIES: Capabilities = { tools: false, web: false };

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Response cache. Keys arriving here are already content-hashed and
 * tenant-namespaced by the runner; implementations only store and expire.
 */
export interface AiCache {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
}

// ---------------------------------------------------------------------------
// Budget (two-phase: reserve worst-case, settle actual, release the remainder)
// ---------------------------------------------------------------------------

export interface BudgetAmount {
  tokens: number;
  usd: number;
}

export interface BudgetReservation {
  id: string;
  key: string;
  reserved: BudgetAmount;
}

/**
 * Metering primitive. Policy (limits per tier, over-limit UX) is app code: the
 * caller passes the limit with each reservation via AiContext.budget.
 *
 * A plain precheck overspends under parallel fan-out, retries, repair passes,
 * and delegation — reserve() must be atomic against concurrent reservations.
 */
export interface AiBudgetStore {
  /**
   * Atomically reserve `amount` against `key`, failing if reserved + spent
   * would exceed `limit`. Returns null when the reservation cannot be granted.
   */
  reserve(key: string, amount: BudgetAmount, limit: BudgetAmount): Promise<BudgetReservation | null>;
  /** Record actual spend and release the unused remainder of the reservation. */
  settle(reservation: BudgetReservation, actual: BudgetAmount): Promise<void>;
  /** Release a reservation without recording spend (run failed before the call). */
  release(reservation: BudgetReservation): Promise<void>;
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface AiSubject {
  userId?: string;
  tenantId?: string;
}

export interface AiBudgetConfig {
  store: AiBudgetStore;
  /** e.g. `tenant:${id}:ai:2026-07` — the app composes period into the key. */
  key: string;
  limit: BudgetAmount;
}

/**
 * Everything ambient a run needs. Tenancy is a context concern: `subject.tenantId`
 * flows into cache namespacing, budget keys, and telemetry automatically.
 *
 * ai-kit never opens database connections. Data isolation stays behind the
 * app's own RLS adapters, and nothing may hold a database transaction open
 * across a model call.
 */
export interface AiContext<TRender = unknown> {
  subject?: AiSubject;
  budget?: AiBudgetConfig;
  cache?: AiCache;
  telemetry?: (event: import('../telemetry/events.js').AiTelemetryEvent) => void;
  /** App-provided data handed to the task's render() (e.g. tenant business profile). */
  render?: TRender;
  /** Capability flags for capability-conditional instructions. */
  capabilities?: Capabilities;
  /** Override the task's default profile (how apps map subscription tier to profile). */
  profileOverride?: string;
  /** Kill switch; when true every run throws AiDisabledError. */
  disabled?: boolean;
}
