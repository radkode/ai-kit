import type {
  AiBudgetConfig,
  AiContext,
  AiRunMeta,
  AiRunResult,
  AiUsage,
  BudgetReservation,
} from '../core/contracts.js';
import { DEFAULT_CAPABILITIES } from '../core/contracts.js';
import {
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiError,
  AiInputInvalidError,
  AiOutputInvalidError,
  ProviderOutputError,
} from '../core/errors.js';
import { generateStructured } from '../core/provider.js';
import { estimateCostUsd, resolveModel, PRICING_VERSION, type ModelInfo } from '../registry/models.js';
import { resolveProfile, type Profile } from '../registry/profiles.js';
import { joinParts, text, type PromptPart } from '../spec/prompt.js';
import type { AiTaskDefinition } from '../spec/task.js';
import { runCacheKey } from './hash.js';
import { salvageJson } from './salvage.js';

const ZERO_USAGE: AiUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
};

/**
 * Worst-case input-token estimate for budget reservation. Deliberately
 * conservative (non-Latin scripts approach one token per character): budgets
 * must fail toward over-reserving, and the surplus is released at settlement.
 */
function estimateInputTokens(instructions: string, parts: PromptPart[]): number {
  const chars = instructions.length + parts.reduce((n, p) => n + p.text.length, 0);
  return Math.ceil(chars / 2) + 128;
}

function addUsage(a: AiUsage, b: AiUsage): AiUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cachedInputTokens: a.cachedInputTokens + b.cachedInputTokens,
    cacheWriteInputTokens: a.cacheWriteInputTokens + b.cacheWriteInputTokens,
  };
}

function totalTokens(usage: AiUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/**
 * Tracks every reservation taken for one run and settles them exactly once.
 *
 * Settlement contract: the total actual spend is settled against the first
 * reservation and the rest are released; the net ledger effect is identical
 * and each reservation is touched once. Metering-infrastructure failures are
 * swallowed here on purpose: a successful (already billed) generation must
 * not be failed, retried, or double-settled because the budget store
 * hiccupped, and unsettled reservations self-heal via the store's staleness
 * sweep. The failure direction is temporarily over-reserved, never overspent.
 */
class RunBudget {
  private reservations: BudgetReservation[] = [];
  private closed = false;

  constructor(private readonly config: AiBudgetConfig | undefined) {}

  async reserveOrThrow(amount: { tokens: number; usd: number }): Promise<void> {
    if (!this.config) return;
    let reservation: BudgetReservation | null;
    try {
      reservation = await this.config.store.reserve(this.config.key, amount, this.config.limit);
    } catch (cause) {
      throw new AiError('provider', 'Budget store reservation failed', { cause, retryable: true });
    }
    if (!reservation) throw new AiBudgetExceededError(this.config.key);
    this.reservations.push(reservation);
  }

  async settle(actual: AiUsage, costUsd: number): Promise<void> {
    if (!this.config || this.closed) return;
    this.closed = true;
    const [first, ...rest] = this.reservations;
    this.reservations = [];
    try {
      if (first) {
        await this.config.store.settle(first, { tokens: totalTokens(actual), usd: costUsd });
      }
      for (const extra of rest) await this.config.store.release(extra);
    } catch {
      // Swallowed: see class docstring.
    }
  }

  async releaseAll(): Promise<void> {
    if (!this.config || this.closed) return;
    this.closed = true;
    const held = this.reservations;
    this.reservations = [];
    try {
      for (const reservation of held) await this.config.store.release(reservation);
    } catch {
      // Swallowed: see class docstring.
    }
  }
}

/**
 * Execute one TaskDefinition: validate input, check the tenant-namespaced
 * cache, reserve budget (again before any paid repair call), call the provider
 * with schema-enforced output, salvage or repair invalid output at most once,
 * settle the budget against actual usage (successful AND failed attempts both
 * settle what they consumed), emit telemetry, and return the validated output
 * with full provenance.
 *
 * Failures throw typed AiErrors. There are no silent fallbacks: a fallback
 * profile runs only when the definition declares one, and its use is recorded
 * in meta and telemetry.
 */
export async function runTask<In, Out, TRender = unknown>(
  definition: AiTaskDefinition<In, Out, TRender>,
  input: In,
  ctx: AiContext<TRender> = {},
): Promise<AiRunResult<Out>> {
  const startedAt = Date.now();

  if (ctx.disabled || process.env.AI_DISABLED === 'true') throw new AiDisabledError();

  const parsedInput = definition.input.safeParse(input);
  if (!parsedInput.success) {
    throw new AiInputInvalidError(
      `Invalid input for task ${definition.id}`,
      parsedInput.error.issues,
    );
  }

  const capabilities = ctx.capabilities ?? DEFAULT_CAPABILITIES;
  const primaryProfileName = ctx.profileOverride ?? definition.profile;
  const primary = mustResolveProfile(definition, primaryProfileName);
  const primaryModel = resolveModel(primary.model);
  const tenantId = ctx.subject?.tenantId;

  const emit = (event: import('../telemetry/events.js').AiTelemetryEvent): void => {
    try {
      ctx.telemetry?.(event);
    } catch {
      // A telemetry sink must never break a run.
    }
  };
  const eventBase = (profile: Profile, model: ModelInfo) => ({
    taskId: definition.id,
    taskVersion: definition.version,
    profile: profile.name,
    model: model.id,
    provider: model.provider,
    ...(tenantId !== undefined ? { tenantId } : {}),
    ...(ctx.subject?.userId !== undefined ? { userId: ctx.subject.userId } : {}),
  });

  // Cache check (opt-in per definition). The key covers everything that shapes
  // the prompt; corrupt or invalid entries are treated as misses, never errors.
  let cacheKey: string | undefined;
  if (definition.cache && ctx.cache) {
    cacheKey = runCacheKey({
      taskId: definition.id,
      taskVersion: definition.version,
      model: primaryModel.id,
      input: parsedInput.data,
      tenantId,
      capabilities,
      renderData: ctx.render,
    });
    const hit = await guarded(() => ctx.cache!.get(cacheKey!));
    if (hit !== null && hit !== undefined) {
      const revalidated = parseCached(hit, definition);
      if (revalidated !== undefined) {
        const latencyMs = Date.now() - startedAt;
        emit({ type: 'cache_hit', ...eventBase(primary, primaryModel), latencyMs });
        return {
          output: revalidated,
          meta: {
            taskId: definition.id,
            taskVersion: definition.version,
            provider: primaryModel.provider,
            model: primaryModel.id,
            profile: primary.name,
            usage: ZERO_USAGE,
            costUsd: 0,
            pricingVersion: PRICING_VERSION,
            latencyMs,
            cached: true,
          },
        };
      }
    }
  }

  const instructions = definition.instructions(capabilities);
  const parts = definition.render(parsedInput.data, { data: ctx.render, capabilities });

  const attempts: Profile[] = [primary];
  if (definition.fallbackProfile) {
    attempts.push(mustResolveProfile(definition, definition.fallbackProfile));
  }

  let totalUsage = ZERO_USAGE;
  let totalCostUsd = 0;
  let lastError: unknown;

  for (let attemptIndex = 0; attemptIndex < attempts.length; attemptIndex++) {
    const profile = attempts[attemptIndex]!;
    const model = resolveModel(profile.model);
    const isFallback = attemptIndex > 0;
    const budget = new RunBudget(ctx.budget);

    try {
      await budget.reserveOrThrow(reserveAmountFor(model, instructions, parts, profile));

      const { output, usage, recovery } = await generateWithRepair(
        definition,
        profile,
        model,
        instructions,
        parts,
        budget,
      );
      totalUsage = addUsage(totalUsage, usage);
      const attemptCost = estimateCostUsd(model, usage);
      totalCostUsd += attemptCost;
      await budget.settle(usage, attemptCost);

      const latencyMs = Date.now() - startedAt;
      const meta: AiRunMeta = {
        taskId: definition.id,
        taskVersion: definition.version,
        provider: model.provider,
        model: model.id,
        profile: profile.name,
        usage: totalUsage,
        costUsd: totalCostUsd,
        pricingVersion: PRICING_VERSION,
        latencyMs,
        cached: false,
        ...(recovery ? { recovery } : {}),
        ...(isFallback ? { fallbackProfile: profile.name } : {}),
      };

      // Cache only primary-profile output: a fallback response under the
      // primary key would poison future primary runs.
      if (cacheKey && definition.cache && ctx.cache && !isFallback) {
        await guarded(() =>
          ctx.cache!.set(cacheKey!, JSON.stringify(output), definition.cache!.ttlSeconds),
        );
      }

      emit({
        type: 'run_completed',
        ...eventBase(profile, model),
        meta,
        ...(definition.telemetry?.recordContent
          ? {
              content: {
                prompt: `${instructions}\n\n${joinParts(parts)}`,
                output: JSON.stringify(output),
              },
            }
          : {}),
      });

      return { output: output as Out, meta };
    } catch (error) {
      lastError = error;
      const aiError = toAiError(error, definition.id);

      // Failed attempts still consumed real tokens; settle what we know about,
      // release the rest. Both directions are safe: settle records true spend,
      // release only frees reservation headroom.
      const consumed = usageConsumedBy(error);
      const failedCost = estimateCostUsd(model, consumed);
      totalUsage = addUsage(totalUsage, consumed);
      totalCostUsd += failedCost;
      if (totalTokens(consumed) > 0) {
        await budget.settle(consumed, failedCost);
      } else {
        await budget.releaseAll();
      }

      emit({
        type: 'run_failed',
        ...eventBase(profile, model),
        errorCode: aiError.code,
        errorMessage: aiError.message,
        latencyMs: Date.now() - startedAt,
        retries: 0,
      });

      // Only provider-side failures may try the declared fallback profile.
      const mayFallback =
        attemptIndex < attempts.length - 1 &&
        (aiError.code === 'provider' ||
          aiError.code === 'rate_limit' ||
          aiError.code === 'timeout' ||
          aiError.code === 'output_invalid');
      if (!mayFallback) throw aiError;
    }
  }

  throw toAiError(lastError, definition.id);
}

function guarded<T>(fn: () => Promise<T>): Promise<T | undefined> {
  return fn().catch(() => undefined);
}

function parseCached<In, Out, TRender>(
  hit: string,
  definition: AiTaskDefinition<In, Out, TRender>,
): Out | undefined {
  try {
    const revalidated = definition.output.safeParse(JSON.parse(hit));
    return revalidated.success ? revalidated.data : undefined;
  } catch {
    return undefined;
  }
}

function mustResolveProfile<In, Out, TRender>(
  definition: AiTaskDefinition<In, Out, TRender>,
  name: string,
): Profile {
  const profile = resolveProfile(name, definition.overrides);
  if (!profile) {
    throw new AiConfigError(`Task ${definition.id}: unknown profile "${name}"`);
  }
  return profile;
}

function reserveAmountFor(
  model: ModelInfo,
  instructions: string,
  parts: PromptPart[],
  profile: Profile,
): { tokens: number; usd: number } {
  const inputTokens = estimateInputTokens(instructions, parts);
  const tokens = inputTokens + profile.maxOutputTokens;
  const usd = estimateCostUsd(model, {
    inputTokens,
    outputTokens: profile.maxOutputTokens,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
  });
  return { tokens, usd };
}

function usageConsumedBy(error: unknown): AiUsage {
  if (error instanceof ProviderOutputError) return error.usage;
  if (error instanceof AiOutputInvalidError && error.usageConsumed) return error.usageConsumed;
  return ZERO_USAGE;
}

interface GenerateOutcome {
  output: unknown;
  usage: AiUsage;
  recovery?: 'salvage' | 'repair';
}

/**
 * One provider call with schema enforcement, then at most one recovery step:
 * first a free salvage parse of the raw text, then a single paid repair call
 * that feeds the validation errors back to the model. The paid repair takes
 * its own budget reservation before spending.
 *
 * Every thrown error carries the usage consumed so far so the caller settles
 * real spend even on failure.
 */
async function generateWithRepair<In, Out, TRender>(
  definition: AiTaskDefinition<In, Out, TRender>,
  profile: Profile,
  model: ModelInfo,
  instructions: string,
  parts: PromptPart[],
  budget: RunBudget,
): Promise<GenerateOutcome> {
  let usage = ZERO_USAGE;
  try {
    const result = await generateStructured({
      model,
      profile,
      instructions,
      parts,
      outputSchema: definition.output,
      taskId: definition.id,
    });
    return { output: result.output, usage: result.usage };
  } catch (error) {
    if (!(error instanceof ProviderOutputError)) throw error;
    usage = addUsage(usage, error.usage);

    // Free salvage: fence-stripping + brace extraction + zod validation.
    if (error.rawText) {
      const salvaged = salvageJson(error.rawText, definition.output);
      if (salvaged.success) {
        return { output: salvaged.data, usage, recovery: 'salvage' };
      }
    }

    // One paid repair pass, with its own reservation before spending.
    await budget.reserveOrThrow(
      reserveAmountFor(model, instructions, [...parts, text(error.rawText ?? '')], profile),
    );
    const repairParts: PromptPart[] = [
      ...parts,
      text(
        [
          'Your previous response did not match the required schema.',
          `Previous response:\n${error.rawText ?? '(empty)'}`,
          `Validation errors:\n${JSON.stringify(error.issues ?? 'unknown')}`,
          'Respond again with ONLY a corrected response that satisfies the schema.',
        ].join('\n\n'),
      ),
    ];
    try {
      const repairedResult = await generateStructured({
        model,
        profile,
        instructions,
        parts: repairParts,
        outputSchema: definition.output,
        taskId: definition.id,
      });
      return {
        output: repairedResult.output,
        usage: addUsage(usage, repairedResult.usage),
        recovery: 'repair',
      };
    } catch (repairError) {
      if (repairError instanceof ProviderOutputError) {
        throw new AiOutputInvalidError(
          `Task ${definition.id}: output failed validation after repair`,
          {
            issues: repairError.issues,
            ...(repairError.rawText !== undefined ? { rawOutput: repairError.rawText } : {}),
            usageConsumed: addUsage(usage, repairError.usage),
            cause: repairError,
          },
        );
      }
      // Non-schema repair failure (rate limit, timeout): keep the first
      // call's spend attached so the caller can settle it.
      if (repairError instanceof AiError) {
        throw new AiOutputInvalidError(
          `Task ${definition.id}: repair call failed (${repairError.code}) after invalid output`,
          { issues: error.issues, usageConsumed: usage, cause: repairError },
        );
      }
      throw repairError;
    }
  }
}

function toAiError(error: unknown, taskId: string): AiError {
  if (error instanceof AiError) return error;
  if (error instanceof ProviderOutputError) {
    return new AiOutputInvalidError(`Task ${taskId}: output failed schema validation`, {
      issues: error.issues,
      ...(error.rawText !== undefined ? { rawOutput: error.rawText } : {}),
      usageConsumed: error.usage,
      cause: error,
    });
  }
  return new AiError('provider', `Task ${taskId} failed: ${String(error)}`, { cause: error });
}
