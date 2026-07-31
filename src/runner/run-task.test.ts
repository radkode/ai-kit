import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoTriageTask } from '../__fixtures__/demo-task.js';
import { memoryBudget, memoryCache } from '../adapters/memory.js';
import type { AiBudgetStore, AiCache } from '../core/contracts.js';
import type { AiTelemetryEvent } from '../telemetry/events.js';
import { AiBudgetExceededError, AiInputInvalidError, AiOutputInvalidError } from '../core/errors.js';
import { runTask } from './run-task.js';

vi.mock('../core/provider.js', async () => {
  const actual =
    await vi.importActual<typeof import('../core/provider.js')>('../core/provider.js');
  return { ...actual, generateStructured: vi.fn(), generatePlainText: vi.fn() };
});

const { generateStructured, ProviderOutputError } = await import('../core/provider.js');
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
