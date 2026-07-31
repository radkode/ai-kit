import type { AiRunMeta } from '../core/contracts.js';

/**
 * Telemetry is metadata-only by default: model, tokens, cost, latency, ids.
 * Prompt/completion content appears only when the task explicitly opts in via
 * `telemetry.recordContent`, and even then tool arguments and rendered prompts
 * pass through the task's redaction rules first. Sinks (PostHog, logger, DB)
 * are app-side; ai-kit emits one event per run outcome to `ctx.telemetry`.
 */

export interface AiRunEventBase {
  taskId: string;
  taskVersion: string;
  profile: string;
  model: string;
  provider: string;
  tenantId?: string;
  userId?: string;
}

export interface AiRunCompletedEvent extends AiRunEventBase {
  type: 'run_completed';
  meta: AiRunMeta;
  /** Present only when the task opted into content recording. */
  content?: { prompt: string; output: string };
}

export interface AiRunFailedEvent extends AiRunEventBase {
  type: 'run_failed';
  errorCode: string;
  errorMessage: string;
  latencyMs: number;
  retries: number;
}

export interface AiCacheHitEvent extends AiRunEventBase {
  type: 'cache_hit';
  latencyMs: number;
}

export type AiTelemetryEvent = AiRunCompletedEvent | AiRunFailedEvent | AiCacheHitEvent;
