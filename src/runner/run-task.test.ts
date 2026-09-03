import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { demoTriageTask } from '../__fixtures__/demo-task.js';
import { memoryBudget, memoryCache } from '../adapters/memory.js';
import type { AiBudgetStore, AiCache } from '../core/contracts.js';
import type { AiTelemetryEvent } from '../telemetry/events.js';
import {
  AiBudgetExceededError,
  AiConfigError,
  AiDisabledError,
  AiError,
  AiInputInvalidError,
  AiOutputInvalidError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  ProviderOutputError,
} from '../core/errors.js';
import { defineAiTask } from '../spec/task.js';
import { runTask } from './run-task.js';

vi.mock('../core/provider.js', async () => {
  const actual =
    await vi.importActual<typeof import('../core/provider.js')>('../core/provider.js');
  return { ...actual, generateStructured: vi.fn(), generatePlainText: vi.fn() };
});

const { generateStructured } = await import('../core/provider.js');
const mockedGenerate = vi.mocked(generateStructured);

const VALID_OUTPUT = {
  title: 'Email vendor about pallet jack',
  priority: 'high' as const,
  reason: 'Blocking warehouse operations',
};
const USAGE = { inputTokens: 200, outputTokens: 50, cachedInputTokens: 0, cacheWriteInputTokens: 0 };
const INPUT = { captureText: 'email the vendor about the broken pallet jack' };

beforeEach(() => {
  mockedGenerate.mockReset();
});

describe('runTask', () => {
  it('returns validated output with full provenance meta', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });

    const result = await runTask(demoTriageTask, INPUT);

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.meta).toMatchObject({
      taskId: 'demo.capture-triage',
      taskVersion: '1',
      profile: 'fast-structured',
      model: 'claude-haiku-4-5',
      provider: 'anthropic',
      cached: false,
    });
    expect(result.meta.recovery).toBeUndefined();
    expect(result.meta.costUsd).toBeGreaterThan(0);
    expect(result.meta.pricingVersion).toBeTruthy();
  });

  it('rejects invalid input without calling the provider', async () => {
    await expect(runTask(demoTriageTask, { captureText: '' })).rejects.toBeInstanceOf(
      AiInputInvalidError,
    );
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('reserves and settles the budget against actual usage', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const store = memoryBudget();
    const reserveSpy = vi.spyOn(store, 'reserve');
    const settleSpy = vi.spyOn(store, 'settle');

    await runTask(demoTriageTask, INPUT, {
      budget: { store, key: 'tenant:t1:2026-07', limit: { tokens: 100_000, usd: 1 } },
    });

    expect(reserveSpy).toHaveBeenCalledOnce();
    expect(settleSpy).toHaveBeenCalledOnce();
    const settled = settleSpy.mock.calls[0]![1];
    expect(settled.tokens).toBe(USAGE.inputTokens + USAGE.outputTokens);
    expect(settled.usd).toBeGreaterThan(0);
  });

  it('throws AiBudgetExceededError when the reservation is denied', async () => {
    const store = memoryBudget();
    await expect(
      runTask(demoTriageTask, INPUT, {
        budget: { store, key: 'tenant:t1:2026-07', limit: { tokens: 1, usd: 0.000001 } },
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('emits run_failed telemetry when the budget is exhausted', async () => {
    const store = memoryBudget();
    const events: AiTelemetryEvent[] = [];
    await expect(
      runTask(demoTriageTask, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 1, usd: 0.000001 } },
        telemetry: (e) => events.push(e),
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    const failed = events.find((e) => e.type === 'run_failed');
    expect(failed).toMatchObject({ errorCode: 'budget_exceeded' });
  });

  it('settles real spend when every attempt fails (no free overspend for failing tasks)', async () => {
    mockedGenerate.mockRejectedValue(
      new ProviderOutputError('invalid', { rawText: 'not json at all', usage: USAGE }),
    );
    const store = memoryBudget();
    const settleSpy = vi.spyOn(store, 'settle');
    const releaseSpy = vi.spyOn(store, 'release');
    const limit = { tokens: 100_000, usd: 1 };

    await expect(
      runTask(demoTriageTask, INPUT, { budget: { store, key: 'k', limit } }),
    ).rejects.toBeInstanceOf(AiOutputInvalidError);

    // First call + paid repair call both failed: 500 tokens of real spend,
    // settled once in full; the surplus repair reservation is released.
    expect(settleSpy).toHaveBeenCalledOnce();
    expect(settleSpy.mock.calls[0]![1].tokens).toBe(2 * (USAGE.inputTokens + USAGE.outputTokens));
    expect(releaseSpy).toHaveBeenCalledOnce();

    // The spend is on the ledger: ten failing runs cannot reserve forever.
    const remainingReserve = await store.reserve('k', { tokens: 99_600, usd: 0.9 }, limit);
    expect(remainingReserve).toBeNull();
  });

  it('carries first-call spend out when the repair call fails with a non-schema error', async () => {
    const { AiRateLimitError } = await import('../core/errors.js');
    mockedGenerate
      .mockRejectedValueOnce(
        new ProviderOutputError('invalid', { rawText: 'not json', usage: USAGE }),
      )
      .mockRejectedValueOnce(new AiRateLimitError('rate limited'));
    const store = memoryBudget();
    const settleSpy = vi.spyOn(store, 'settle');

    await expect(
      runTask(demoTriageTask, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 100_000, usd: 1 } },
      }),
    ).rejects.toBeInstanceOf(AiOutputInvalidError);

    expect(settleSpy).toHaveBeenCalledOnce();
    expect(settleSpy.mock.calls[0]![1].tokens).toBe(USAGE.inputTokens + USAGE.outputTokens);
  });

  it('takes a second reservation before the paid repair call', async () => {
    mockedGenerate
      .mockRejectedValueOnce(
        new ProviderOutputError('invalid', { rawText: 'not json', usage: USAGE }),
      )
      .mockResolvedValueOnce({ output: VALID_OUTPUT, usage: USAGE });
    const store = memoryBudget();
    const reserveSpy = vi.spyOn(store, 'reserve');

    const result = await runTask(demoTriageTask, INPUT, {
      budget: { store, key: 'k', limit: { tokens: 100_000, usd: 1 } },
    });

    expect(result.meta.recovery).toBe('repair');
    expect(reserveSpy).toHaveBeenCalledTimes(2);
    // Total spend across both calls is settled once.
    expect(result.meta.usage.inputTokens).toBe(USAGE.inputTokens * 2);
  });

  it('denies the repair call when the budget cannot cover it', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ProviderOutputError('invalid', { rawText: 'not json', usage: USAGE }),
    );
    const store = memoryBudget();
    // Enough for exactly one worst-case reservation, not two.
    const limitReserve = await store.reserve('probe', { tokens: 1, usd: 0.0001 }, { tokens: 10, usd: 1 });
    expect(limitReserve).not.toBeNull();

    await expect(
      runTask(demoTriageTask, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 2600, usd: 1 } },
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it('does not double-settle or fail the run when settle itself rejects', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const inner = memoryBudget();
    let settleCalls = 0;
    const store: AiBudgetStore = {
      reserve: (key, amount, limit) => inner.reserve(key, amount, limit),
      settle: async (r, a) => {
        settleCalls += 1;
        if (settleCalls === 1) throw new Error('transient store failure');
        await inner.settle(r, a);
      },
      release: (r) => inner.release(r),
    };

    const result = await runTask(demoTriageTask, INPUT, {
      budget: { store, key: 'k', limit: { tokens: 100_000, usd: 1 } },
    });

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(settleCalls).toBe(1);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it('salvages malformed output for free before paying for a repair call', async () => {
    mockedGenerate.mockRejectedValueOnce(
      new ProviderOutputError('invalid', {
        rawText: 'Here you go:\n```json\n' + JSON.stringify(VALID_OUTPUT) + '\n```',
        usage: USAGE,
      }),
    );

    const result = await runTask(demoTriageTask, INPUT);

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.meta.recovery).toBe('salvage');
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it('serves cache hits tenant-namespaced with zero cost', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const cache = memoryCache();
    const events: AiTelemetryEvent[] = [];
    const ctxA = {
      cache,
      subject: { tenantId: 'tenant-a' },
      telemetry: (e: AiTelemetryEvent) => events.push(e),
    };

    const first = await runTask(demoTriageTask, INPUT, ctxA);
    const second = await runTask(demoTriageTask, INPUT, ctxA);
    expect(first.meta.cached).toBe(false);
    expect(second.meta.cached).toBe(true);
    expect(second.meta.costUsd).toBe(0);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'cache_hit')).toBe(true);

    // A different tenant must miss: same input, different namespace.
    await runTask(demoTriageTask, INPUT, { cache, subject: { tenantId: 'tenant-b' } });
    expect(mockedGenerate).toHaveBeenCalledTimes(2);

    // Different render data shapes a different prompt: also a miss.
    await runTask(demoTriageTask, INPUT, {
      cache,
      subject: { tenantId: 'tenant-a' },
      render: { userTimezone: 'Europe/Warsaw' },
    });
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
  });

  it('treats corrupt or failing cache entries as misses, never errors', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const broken: AiCache = {
      get: async () => 'not-valid-json{{{',
      set: async () => {
        throw new Error('write failed');
      },
    };

    const result = await runTask(demoTriageTask, INPUT, { cache: broken });
    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.meta.cached).toBe(false);
  });

  it('emits run_completed telemetry without content by default, and a throwing sink never breaks the run', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const events: AiTelemetryEvent[] = [];

    const result = await runTask(demoTriageTask, INPUT, {
      telemetry: (e) => {
        events.push(e);
        throw new Error('sink exploded');
      },
    });

    expect(result.output).toEqual(VALID_OUTPUT);
    const completed = events.find((e) => e.type === 'run_completed');
    expect(completed).toBeDefined();
    expect(completed && 'content' in completed && completed.content).toBeFalsy();
  });
});

describe('runTask kill switch', () => {
  afterEach(() => {
    delete process.env.AI_DISABLED;
  });

  it('throws AiDisabledError from ctx before validating input or spending anything', async () => {
    await expect(
      runTask(demoTriageTask, { captureText: '' }, { disabled: true }),
    ).rejects.toBeInstanceOf(AiDisabledError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('honours the AI_DISABLED env var without a ctx flag', async () => {
    process.env.AI_DISABLED = 'true';
    await expect(runTask(demoTriageTask, INPUT)).rejects.toBeInstanceOf(AiDisabledError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('ignores any AI_DISABLED value other than the literal true', async () => {
    process.env.AI_DISABLED = '1';
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    await expect(runTask(demoTriageTask, INPUT)).resolves.toBeDefined();
  });
});

describe('runTask profile resolution', () => {
  it('rejects a task pointing at a profile the registry does not have', async () => {
    const broken = defineAiTask({ ...demoTriageTask, profile: 'nonexistent' });
    const error = await runTask(broken, INPUT).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiConfigError);
    expect((error as AiConfigError).message).toContain('nonexistent');
    expect((error as AiConfigError).message).toContain('demo.capture-triage');
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('lets ctx.profileOverride win over the definition default', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const result = await runTask(demoTriageTask, INPUT, { profileOverride: 'deep' });

    expect(result.meta.profile).toBe('deep');
    expect(result.meta.model).toBe('claude-opus-5');
    expect(result.meta.fallbackProfile).toBeUndefined();
  });

  it('rejects an unknown profileOverride rather than silently falling back to the default', async () => {
    await expect(
      runTask(demoTriageTask, INPUT, { profileOverride: 'premium' }),
    ).rejects.toBeInstanceOf(AiConfigError);
  });

  it('applies definition overrides to the profile handed to the provider', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const tuned = defineAiTask({
      ...demoTriageTask,
      overrides: { temperature: 0.9, maxOutputTokens: 77, timeoutMs: 1234, maxRetries: 5 },
    });

    await runTask(tuned, INPUT);

    expect(mockedGenerate.mock.calls[0]![0].profile).toMatchObject({
      temperature: 0.9,
      maxOutputTokens: 77,
      timeoutMs: 1234,
      maxRetries: 5,
    });
  });
});

describe('runTask declared fallback profile', () => {
  const withFallback = defineAiTask({
    ...demoTriageTask,
    id: 'demo.capture-triage-fallback',
    fallbackProfile: 'balanced',
  });

  it('never makes a second attempt when no fallback is declared', async () => {
    mockedGenerate.mockRejectedValue(new AiRateLimitError('rate limited'));
    await expect(runTask(demoTriageTask, INPUT)).rejects.toBeInstanceOf(AiRateLimitError);
    expect(mockedGenerate).toHaveBeenCalledTimes(1);
  });

  it('runs the declared fallback on a provider failure and records that it did', async () => {
    mockedGenerate
      .mockRejectedValueOnce(new AiRateLimitError('rate limited'))
      .mockResolvedValueOnce({ output: VALID_OUTPUT, usage: USAGE });

    const result = await runTask(withFallback, INPUT);

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.meta.profile).toBe('balanced');
    expect(result.meta.model).toBe('claude-sonnet-5');
    expect(result.meta.fallbackProfile).toBe('balanced');
  });

  it('accumulates the failed attempt spend into the recorded usage and cost', async () => {
    mockedGenerate
      .mockRejectedValueOnce(new ProviderOutputError('invalid', { rawText: 'nope', usage: USAGE }))
      .mockRejectedValueOnce(new ProviderOutputError('invalid', { rawText: 'nope', usage: USAGE }))
      .mockResolvedValueOnce({ output: VALID_OUTPUT, usage: USAGE });

    const result = await runTask(withFallback, INPUT);

    // Primary call, its paid repair, then the fallback: three calls, all billed.
    expect(mockedGenerate).toHaveBeenCalledTimes(3);
    expect(result.meta.usage.inputTokens).toBe(USAGE.inputTokens * 3);
    expect(result.meta.fallbackProfile).toBe('balanced');
  });

  it('does not fall back when the failure is the tenant running out of budget', async () => {
    const store = memoryBudget();
    await expect(
      runTask(withFallback, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 1, usd: 0.000001 } },
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('gates the fallback on the error code, not merely on a fallback being declared', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const inner = memoryBudget();
    let reserves = 0;
    // Denies the primary attempt only; a fallback attempt would be granted.
    const store: AiBudgetStore = {
      reserve: async (key, amount, limit) => {
        reserves += 1;
        return reserves === 1 ? null : inner.reserve(key, amount, limit);
      },
      settle: (r, a) => inner.settle(r, a),
      release: (r) => inner.release(r),
    };

    await expect(
      runTask(withFallback, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 100_000, usd: 1 } },
      }),
    ).rejects.toBeInstanceOf(AiBudgetExceededError);

    // Running out of budget is not a provider failure, so no second attempt.
    expect(reserves).toBe(1);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('falls back on a non-retryable provider error, since another model may accept the call', async () => {
    mockedGenerate
      .mockRejectedValueOnce(new AiProviderError('bad request', { statusCode: 400, retryable: false }))
      .mockResolvedValueOnce({ output: VALID_OUTPUT, usage: USAGE });

    const result = await runTask(withFallback, INPUT);
    expect(result.meta.fallbackProfile).toBe('balanced');
  });

  it('throws the fallback failure and reports both attempts when the fallback fails too', async () => {
    mockedGenerate
      .mockRejectedValueOnce(new AiRateLimitError('primary rate limited'))
      .mockRejectedValueOnce(new AiTimeoutError('fallback timed out'));
    const events: AiTelemetryEvent[] = [];

    const error = await runTask(withFallback, INPUT, {
      telemetry: (e) => events.push(e),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiTimeoutError);
    const failures = events.filter((e) => e.type === 'run_failed');
    expect(failures).toHaveLength(2);
    expect(failures.map((e) => e.profile)).toEqual(['fast-structured', 'balanced']);
  });

  it('keeps fallback output out of the cache, so it cannot poison later primary runs', async () => {
    const cache = memoryCache();
    const setSpy = vi.spyOn(cache, 'set');
    mockedGenerate
      .mockRejectedValueOnce(new AiRateLimitError('rate limited'))
      .mockResolvedValueOnce({ output: VALID_OUTPUT, usage: USAGE });

    const fallbackRun = await runTask(withFallback, INPUT, { cache });
    expect(fallbackRun.meta.fallbackProfile).toBe('balanced');
    expect(setSpy).not.toHaveBeenCalled();

    // A primary-served run does write, so the check above is not vacuous.
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    await runTask(withFallback, INPUT, { cache });
    expect(setSpy).toHaveBeenCalledOnce();
  });
});

describe('runTask error coercion', () => {
  it('wraps an unrecognized throw as a provider AiError naming the task', async () => {
    const raw = new Error('something exploded');
    mockedGenerate.mockRejectedValue(raw);

    const error = await runTask(demoTriageTask, INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe('provider');
    expect((error as AiError).message).toContain('demo.capture-triage');
    expect((error as AiError).cause).toBe(raw);
  });

  it('wraps a thrown non-Error value too', async () => {
    mockedGenerate.mockRejectedValue('a bare string');
    const error = await runTask(demoTriageTask, INPUT).catch((e: unknown) => e);
    expect((error as AiError).code).toBe('provider');
    expect((error as AiError).message).toContain('a bare string');
  });

  it('propagates a non-schema, non-typed failure from the repair call unwrapped', async () => {
    mockedGenerate
      .mockRejectedValueOnce(new ProviderOutputError('invalid', { rawText: 'nope', usage: USAGE }))
      .mockRejectedValueOnce(new Error('socket hang up during repair'));

    const error = await runTask(demoTriageTask, INPUT).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe('provider');
    expect((error as AiError).message).toContain('socket hang up during repair');
  });
});

describe('runTask budget store outages', () => {
  const failingReserve: AiBudgetStore = {
    reserve: async () => {
      throw new Error('metering infrastructure down');
    },
    settle: async () => {},
    release: async () => {},
  };

  it('distinguishes a broken meter from an exhausted budget', async () => {
    const error = await runTask(demoTriageTask, INPUT, {
      budget: { store: failingReserve, key: 'k', limit: { tokens: 100_000, usd: 1 } },
    }).catch((e: unknown) => e);

    // The caller degrades differently for "out of money" than for "meter is down".
    expect(error).toBeInstanceOf(AiError);
    expect(error).not.toBeInstanceOf(AiBudgetExceededError);
    expect((error as AiError).code).toBe('provider');
    expect((error as AiError).retryable).toBe(true);
    expect(mockedGenerate).not.toHaveBeenCalled();
  });

  it('does not let a failing release mask the real error', async () => {
    mockedGenerate.mockRejectedValue(new AiRateLimitError('rate limited'));
    const inner = memoryBudget();
    const store: AiBudgetStore = {
      reserve: (key, amount, limit) => inner.reserve(key, amount, limit),
      settle: (r, a) => inner.settle(r, a),
      release: async () => {
        throw new Error('release failed');
      },
    };

    await expect(
      runTask(demoTriageTask, INPUT, {
        budget: { store, key: 'k', limit: { tokens: 100_000, usd: 1 } },
      }),
    ).rejects.toBeInstanceOf(AiRateLimitError);
  });

  it('runs without consulting any store when no budget is configured', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const result = await runTask(demoTriageTask, INPUT, {});
    expect(result.output).toEqual(VALID_OUTPUT);
  });
});

describe('runTask telemetry content opt-in', () => {
  it('records the rendered prompt and output only when the task asks for it', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const recording = defineAiTask({ ...demoTriageTask, telemetry: { recordContent: true } });
    const events: AiTelemetryEvent[] = [];

    await runTask(recording, INPUT, { telemetry: (e) => events.push(e) });

    const completed = events.find((e) => e.type === 'run_completed');
    expect(completed?.content?.prompt).toContain('You triage captured task text');
    expect(completed?.content?.prompt).toContain(INPUT.captureText);
    expect(completed?.content?.output).toBe(JSON.stringify(VALID_OUTPUT));
  });

  it('carries the subject ids on every event when a subject is present', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const events: AiTelemetryEvent[] = [];

    await runTask(demoTriageTask, INPUT, {
      subject: { tenantId: 'tenant-a', userId: 'user-1' },
      telemetry: (e) => events.push(e),
    });

    expect(events[0]).toMatchObject({ tenantId: 'tenant-a', userId: 'user-1' });
  });

  it('omits subject ids entirely rather than emitting undefined values', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const events: AiTelemetryEvent[] = [];

    await runTask(demoTriageTask, INPUT, { telemetry: (e) => events.push(e) });

    expect(events[0]).toBeDefined();
    expect(Object.keys(events[0]!)).not.toContain('tenantId');
    expect(Object.keys(events[0]!)).not.toContain('userId');
  });
});

describe('runTask cache revalidation', () => {
  it('treats a cached entry that no longer matches the output schema as a miss', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    // The version-skew case: valid JSON, but shaped for an older output schema.
    const stale: AiCache = {
      get: async () => JSON.stringify({ headline: 'old shape', urgency: 9 }),
      set: async () => {},
    };

    const result = await runTask(demoTriageTask, INPUT, { cache: stale });

    expect(result.output).toEqual(VALID_OUTPUT);
    expect(result.meta.cached).toBe(false);
    expect(mockedGenerate).toHaveBeenCalledOnce();
  });

  it('never touches the cache for a task that declares no cache policy', async () => {
    mockedGenerate.mockResolvedValue({ output: VALID_OUTPUT, usage: USAGE });
    const { cache: _cachePolicy, ...noCachePolicy } = demoTriageTask;
    const uncached = defineAiTask(noCachePolicy);
    const cache = memoryCache();
    const getSpy = vi.spyOn(cache, 'get');
    const setSpy = vi.spyOn(cache, 'set');

    await runTask(uncached, INPUT, { cache });

    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });
});
