import type { z } from 'zod';
import type { Capabilities } from '../core/contracts.js';
import type { PromptPart } from './prompt.js';

/**
 * TaskDefinition: the atom of ai-kit. One model call with a typed contract,
 * the AI equivalent of a pure function. It deliberately contains no control
 * flow; chaining, branching, and delegation live in the agent and workflow
 * layers, in code.
 *
 * Definitions are executable app-side values (instructions and render are
 * functions). Their wire-safe JSON projection is a TaskManifest — see
 * `toManifest()` — which is what HTTP endpoints and MCP resources serve.
 *
 * `version` must be bumped on any prompt or schema change; a lint/test pairing
 * (rendered-prompt snapshot + version assertion) enforces this in consuming
 * repos. `id` + `version` flow into every run's provenance, so what ran can
 * never drift from what was recorded.
 */

export interface RenderContext<TRender = unknown> {
  /** App-provided render data, e.g. a tenant business profile loaded under RLS. */
  data: TRender | undefined;
  capabilities: Capabilities;
}

export interface TaskTelemetryPolicy {
  /** Opt in to recording prompt/output content in telemetry (default false). */
  recordContent?: boolean;
}

export interface TaskCachePolicy {
  ttlSeconds: number;
}

export interface AiTaskDefinition<In, Out, TRender = unknown> {
  /** Globally unique, dot-namespaced: 'cornermind.catalog-drift-triage'. */
  id: string;
  /** Bump on any prompt or schema change. */
  version: string;
  /** Default execution profile; ctx.profileOverride wins at run time. */
  profile: string;
  input: z.ZodType<In>;
  output: z.ZodType<Out>;
  /**
   * Capability-conditional methodology text (the ADR-0004 pattern): one text
   * that serves both a plain completion and a tool-using agent.
   */
  instructions: (caps: Capabilities) => string;
  /** Data-to-prompt renderer. Wrap all untrusted content with xml(). */
  render: (input: In, ctx: RenderContext<TRender>) => PromptPart[];
  /** Response caching is opt-in per task; keys are content-hashed + tenant-namespaced. */
  cache?: TaskCachePolicy;
  /** Declared-only fallback: profile to retry on provider failure. Never implicit. */
  fallbackProfile?: string;
  /** Per-task profile overrides; the only sanctioned place off-profile numbers live. */
  overrides?: {
    temperature?: number;
    maxOutputTokens?: number;
    timeoutMs?: number;
    maxRetries?: number;
  };
  telemetry?: TaskTelemetryPolicy;
}

/** Identity helper that pins generics so consumers get full inference. */
export function defineAiTask<In, Out, TRender = unknown>(
  definition: AiTaskDefinition<In, Out, TRender>,
): AiTaskDefinition<In, Out, TRender> {
  if (!definition.id.includes('.')) {
    throw new Error(`defineAiTask: id "${definition.id}" must be dot-namespaced (app.task-name)`);
  }
  if (!definition.version) {
    throw new Error(`defineAiTask: "${definition.id}" needs a version`);
  }
  return definition;
}
