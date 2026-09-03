import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  RetryError,
  type LanguageModelUsage,
} from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ModelInfo } from '../registry/models.js';
import type { Profile } from '../registry/profiles.js';
import type { PromptPart } from '../spec/prompt.js';
import {
  AiConfigError,
  AiError,
  AiProviderError,
  AiRateLimitError,
  AiTimeoutError,
  ProviderOutputError,
} from './errors.js';
import { generatePlainText, generateStructured, resetProvider } from './provider.js';

vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  generateText: vi.fn(),
}));

const { generateText } = await import('ai');
const mockedGenerateText = vi.mocked(generateText);

const MODEL: ModelInfo = {
  id: 'claude-haiku-4-5',
  provider: 'anthropic',
  inputPerMTok: 1,
  outputPerMTok: 5,
  cachedInputMultiplier: 0.1,
  supportsTemperature: true,
};

const PROFILE: Profile = {
  name: 'fast',
  model: 'claude-haiku-4-5',
  temperature: 0.3,
  maxOutputTokens: 1024,
  timeoutMs: 30_000,
  maxRetries: 2,
};

const SCHEMA = z.object({ ok: z.boolean() });

function usage(overrides: Partial<LanguageModelUsage> = {}): LanguageModelUsage {
  return {
    inputTokens: 100,
    outputTokens: 20,
    totalTokens: 120,
    inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
    ...overrides,
  };
}

function structuredArgs(overrides: Record<string, unknown> = {}) {
  return {
    model: MODEL,
    profile: PROFILE,
    instructions: 'be terse',
    parts: [{ text: 'body' }] as PromptPart[],
    outputSchema: SCHEMA,
    ...overrides,
  };
}

/** The single call the mocked SDK received, for asserting what we sent it. */
function sentArgs(): Record<string, any> {
  expect(mockedGenerateText).toHaveBeenCalledOnce();
  return mockedGenerateText.mock.calls[0]![0] as Record<string, any>;
}

let savedApiKey: string | undefined;
let savedSdkTelemetry: string | undefined;

beforeEach(() => {
  mockedGenerateText.mockReset();
  mockedGenerateText.mockResolvedValue({ output: { ok: true }, text: 'raw', usage: usage() } as any);
  savedApiKey = process.env.ANTHROPIC_API_KEY;
  savedSdkTelemetry = process.env.AI_SDK_TELEMETRY;
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  delete process.env.AI_SDK_TELEMETRY;
  resetProvider();
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedApiKey;
  if (savedSdkTelemetry === undefined) delete process.env.AI_SDK_TELEMETRY;
  else process.env.AI_SDK_TELEMETRY = savedSdkTelemetry;
  resetProvider();
});

describe('model resolution', () => {
  it('rejects a non-anthropic provider by name rather than attempting the call', async () => {
    const foreign = { ...MODEL, provider: 'openai' as unknown as 'anthropic', id: 'gpt-9' };
    await expect(generateStructured(structuredArgs({ model: foreign }))).rejects.toThrow(
      AiConfigError,
    );
    await expect(generateStructured(structuredArgs({ model: foreign }))).rejects.toThrow('gpt-9');
    expect(mockedGenerateText).not.toHaveBeenCalled();
  });

  it('fails with a config error when the API key is absent', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    resetProvider();
    await expect(generateStructured(structuredArgs())).rejects.toThrow(AiConfigError);
    await expect(generateStructured(structuredArgs())).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('memoizes the provider until resetProvider clears it', async () => {
    await generateStructured(structuredArgs());

    // A key rotated out of the env does not reach the memoized client.
    delete process.env.ANTHROPIC_API_KEY;
    await expect(generateStructured(structuredArgs())).resolves.toBeDefined();

    resetProvider();
    await expect(generateStructured(structuredArgs())).rejects.toThrow(AiConfigError);
  });
});

describe('prompt cache breakpoints', () => {
  const CACHE_CONTROL = { anthropic: { cacheControl: { type: 'ephemeral' } } };

  it('places one breakpoint on the last cacheable part, since caching is a prefix mechanism', async () => {
    const parts: PromptPart[] = [
      { text: 'rules', cacheable: true },
      { text: 'more rules', cacheable: true },
      { text: 'volatile' },
    ];
    await generateStructured(structuredArgs({ parts }));

    const content = sentArgs().messages[0].content;
    expect(content.map((c: any) => c.providerOptions)).toEqual([
      undefined,
      CACHE_CONTROL,
      undefined,
    ]);
  });

  it('marks no part when nothing is cacheable', async () => {
    await generateStructured(structuredArgs({ parts: [{ text: 'a' }, { text: 'b' }] }));
    const content = sentArgs().messages[0].content;
    expect(content.every((c: any) => c.providerOptions === undefined)).toBe(true);
  });

  it('folds every part into a single user message, in order', async () => {
    const parts: PromptPart[] = [{ text: 'first' }, { text: 'second' }, { text: 'third' }];
    await generateStructured(structuredArgs({ parts, instructions: 'system text' }));

    const args = sentArgs();
    expect(args.system).toBe('system text');
    expect(args.messages).toHaveLength(1);
    expect(args.messages[0].role).toBe('user');
    expect(args.messages[0].content.map((c: any) => c.text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });
});

describe('usage normalization', () => {
  it('maps cache read and write details onto the normalized shape', async () => {
    mockedGenerateText.mockResolvedValue({
      output: { ok: true },
      usage: usage({
        inputTokens: 500,
        outputTokens: 40,
        inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 300, cacheWriteTokens: 100 },
      }),
    } as any);

    const result = await generateStructured(structuredArgs());
    expect(result.usage).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cachedInputTokens: 300,
      cacheWriteInputTokens: 100,
    });
  });

  it('reports zeros rather than NaN when the provider omits usage', async () => {
    mockedGenerateText.mockResolvedValue({ output: { ok: true }, usage: undefined } as any);
    const result = await generateStructured(structuredArgs());
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });
});

describe('SDK telemetry gate', () => {
  it('sends no telemetry config unless the env var opts in', async () => {
    await generateStructured(structuredArgs({ taskId: 'demo.task' }));
    expect(sentArgs()).not.toHaveProperty('telemetry');
  });

  it('enables spans with content recording off, and tags them with the task id', async () => {
    process.env.AI_SDK_TELEMETRY = 'true';
    await generateStructured(structuredArgs({ taskId: 'demo.task' }));
    expect(sentArgs().telemetry).toEqual({
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      functionId: 'demo.task',
    });
  });

  it('omits functionId when the caller passed no task id', async () => {
    process.env.AI_SDK_TELEMETRY = 'true';
    await generateStructured(structuredArgs());
    expect(sentArgs().telemetry).not.toHaveProperty('functionId');
  });

  it('treats any value other than the literal true as off', async () => {
    process.env.AI_SDK_TELEMETRY = '1';
    await generateStructured(structuredArgs());
    expect(sentArgs()).not.toHaveProperty('telemetry');
  });
});

describe('temperature gate', () => {
  it.each([
    ['generateStructured', (a: Record<string, unknown>) => generateStructured(structuredArgs(a))],
    ['generatePlainText', (a: Record<string, unknown>) => generatePlainText(structuredArgs(a) as any)],
  ])('%s omits temperature on models that reject it', async (_name, run) => {
    await run({ model: { ...MODEL, supportsTemperature: false } });
    expect(sentArgs()).not.toHaveProperty('temperature');
  });

  it.each([
    ['generateStructured', (a: Record<string, unknown>) => generateStructured(structuredArgs(a))],
    ['generatePlainText', (a: Record<string, unknown>) => generatePlainText(structuredArgs(a) as any)],
  ])('%s omits temperature when the profile declares none', async (_name, run) => {
    const { temperature: _drop, ...noTemp } = PROFILE;
    await run({ profile: noTemp });
    expect(sentArgs()).not.toHaveProperty('temperature');
  });

  it.each([
    ['generateStructured', (a: Record<string, unknown>) => generateStructured(structuredArgs(a))],
    ['generatePlainText', (a: Record<string, unknown>) => generatePlainText(structuredArgs(a) as any)],
  ])('%s sends temperature when the model and profile both allow it', async (_name, run) => {
    await run({});
    expect(sentArgs().temperature).toBe(0.3);
  });

  it('forwards the profile token ceiling and retry count', async () => {
    await generateStructured(structuredArgs());
    const args = sentArgs();
    expect(args.maxOutputTokens).toBe(1024);
    expect(args.maxRetries).toBe(2);
    expect(args.abortSignal).toBeInstanceOf(AbortSignal);
  });
});

describe('generatePlainText', () => {
  it('returns the raw text alongside normalized usage', async () => {
    mockedGenerateText.mockResolvedValue({ text: 'plain answer', usage: usage() } as any);
    const result = await generatePlainText({
      model: MODEL,
      profile: PROFILE,
      instructions: 'be terse',
      parts: [{ text: 'body' }],
    });
    expect(result.text).toBe('plain answer');
    expect(result.usage.inputTokens).toBe(100);
    // No structured output means no schema is requested of the SDK.
    expect(sentArgs()).not.toHaveProperty('output');
  });

  it('maps provider failures through the same taxonomy', async () => {
    mockedGenerateText.mockRejectedValue(new NoOutputGeneratedError({ message: 'nothing' }));
    await expect(
      generatePlainText({ model: MODEL, profile: PROFILE, instructions: 'i', parts: [] }),
    ).rejects.toBeInstanceOf(AiProviderError);
  });
});

describe('provider error mapping', () => {
  const call = () => generateStructured(structuredArgs());

  async function rejectWith(error: unknown): Promise<unknown> {
    mockedGenerateText.mockRejectedValue(error);
    return call().then(
      () => {
        throw new Error('expected a rejection');
      },
      (e: unknown) => e,
    );
  }

  it('passes an AiError through untouched, so the runner sees its own taxonomy', async () => {
    const original = new AiConfigError('already typed');
    expect(await rejectWith(original)).toBe(original);
  });

  it('refuses to salvage a response truncated at the token ceiling', async () => {
    const truncated = new NoObjectGeneratedError({
      message: 'cut off',
      text: '{"ok": tr',
      response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
      usage: usage(),
      finishReason: 'length',
    });

    const mapped = await rejectWith(truncated);
    // Salvage cannot complete cut-off JSON and a repair pass would truncate
    // again, so this must not surface as a schema problem.
    expect(mapped).toBeInstanceOf(AiProviderError);
    expect(mapped).not.toBeInstanceOf(ProviderOutputError);
    expect((mapped as AiProviderError).retryable).toBe(false);
    expect((mapped as AiProviderError).message).toContain('maxOutputTokens');
  });

  it('turns a schema failure into a salvageable ProviderOutputError carrying the raw text', async () => {
    const schemaFailure = new NoObjectGeneratedError({
      message: 'bad shape',
      text: '{"ok": "yes"}',
      cause: new Error('expected boolean, received string'),
      response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
      usage: usage({ inputTokens: 300, outputTokens: 12 }),
      finishReason: 'stop',
    });

    const mapped = (await rejectWith(schemaFailure)) as ProviderOutputError;
    expect(mapped).toBeInstanceOf(ProviderOutputError);
    expect(mapped.rawText).toBe('{"ok": "yes"}');
    expect(mapped.issues).toBe('expected boolean, received string');
    expect(mapped.usage).toEqual({
      inputTokens: 300,
      outputTokens: 12,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    });
  });

  it('keeps a non-Error cause on a schema failure as-is', async () => {
    const mapped = (await rejectWith(
      new NoObjectGeneratedError({
        text: 'x',
        cause: { code: 'weird' } as unknown as Error,
        response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
        usage: usage(),
        finishReason: 'stop',
      }),
    )) as ProviderOutputError;
    expect(mapped.issues).toEqual({ code: 'weird' });
  });

  it('omits rawText entirely when the schema failure carried no text', async () => {
    const mapped = (await rejectWith(
      new NoObjectGeneratedError({
        response: { id: 'r', timestamp: new Date(0), modelId: 'm' },
        usage: usage(),
        finishReason: 'stop',
      }),
    )) as ProviderOutputError;
    expect(mapped).toBeInstanceOf(ProviderOutputError);
    expect(mapped.rawText).toBeUndefined();
  });

  it('marks an empty response retryable', async () => {
    const mapped = (await rejectWith(
      new NoOutputGeneratedError({ message: 'empty' }),
    )) as AiProviderError;
    expect(mapped).toBeInstanceOf(AiProviderError);
    expect(mapped.retryable).toBe(true);
  });

  it('distinguishes a rate limit from a generic provider failure', async () => {
    const mapped = (await rejectWith(
      new APICallError({
        message: 'slow down',
        url: 'https://api.anthropic.com',
        requestBodyValues: {},
        statusCode: 429,
      }),
    )) as AiRateLimitError;

    expect(mapped).toBeInstanceOf(AiRateLimitError);
    expect(mapped.code).toBe('rate_limit');
    expect(mapped.retryable).toBe(true);
    expect(mapped.statusCode).toBe(429);
  });

  it('carries status and the SDK retryable verdict on other API failures', async () => {
    const mapped = (await rejectWith(
      new APICallError({
        message: 'bad gateway',
        url: 'https://api.anthropic.com',
        requestBodyValues: {},
        statusCode: 502,
        isRetryable: true,
      }),
    )) as AiProviderError;

    expect(mapped.code).toBe('provider');
    expect(mapped.statusCode).toBe(502);
    expect(mapped.retryable).toBe(true);
  });

  it('reports a non-retryable API failure as non-retryable', async () => {
    const mapped = (await rejectWith(
      new APICallError({
        message: 'bad request',
        url: 'https://api.anthropic.com',
        requestBodyValues: {},
        statusCode: 400,
        isRetryable: false,
      }),
    )) as AiProviderError;
    expect(mapped.retryable).toBe(false);
  });

  it('leaves statusCode undefined when the SDK reported none', async () => {
    const mapped = (await rejectWith(
      new APICallError({ message: 'no status', url: 'u', requestBodyValues: {} }),
    )) as AiProviderError;
    expect(mapped.statusCode).toBeUndefined();
  });

  it('unwraps a rate limit hidden inside an exhausted retry loop', async () => {
    const mapped = (await rejectWith(
      new RetryError({
        message: 'gave up',
        reason: 'maxRetriesExceeded',
        errors: [
          new Error('first attempt'),
          new APICallError({
            message: 'slow down',
            url: 'u',
            requestBodyValues: {},
            statusCode: 429,
          }),
        ],
      }),
    )) as AiRateLimitError;

    // Without unwrapping, an exhausted retry loop would look like a generic failure.
    expect(mapped).toBeInstanceOf(AiRateLimitError);
    expect(mapped.statusCode).toBe(429);
  });

  it('falls back to a generic provider error when a RetryError wraps something else', async () => {
    const mapped = (await rejectWith(
      new RetryError({
        message: 'gave up',
        reason: 'maxRetriesExceeded',
        errors: [new Error('socket hang up')],
      }),
    )) as AiProviderError;
    expect(mapped).toBeInstanceOf(AiProviderError);
    expect(mapped).not.toBeInstanceOf(AiRateLimitError);
  });

  it.each(['AbortError', 'TimeoutError'])('maps a %s to a retryable timeout', async (name) => {
    const aborted = new Error('aborted');
    aborted.name = name;
    const mapped = (await rejectWith(aborted)) as AiTimeoutError;
    expect(mapped).toBeInstanceOf(AiTimeoutError);
    expect(mapped.code).toBe('timeout');
    expect(mapped.retryable).toBe(true);
  });

  it('preserves the message and cause of an unrecognized Error', async () => {
    const raw = new Error('socket hang up');
    const mapped = (await rejectWith(raw)) as AiProviderError;
    expect(mapped).toBeInstanceOf(AiProviderError);
    expect(mapped.message).toBe('socket hang up');
    expect(mapped.cause).toBe(raw);
    expect(mapped.retryable).toBe(false);
  });

  it('stringifies a non-Error throw rather than losing it', async () => {
    const mapped = (await rejectWith('just a string')) as AiProviderError;
    expect(mapped).toBeInstanceOf(AiProviderError);
    expect(mapped).toBeInstanceOf(AiError);
    expect(mapped.message).toBe('just a string');
  });
});
