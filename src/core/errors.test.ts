import { describe, expect, it } from 'vitest';
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
} from './errors.js';

const USAGE = { inputTokens: 10, outputTokens: 2, cachedInputTokens: 0, cacheWriteInputTokens: 0 };

describe('error taxonomy', () => {
  // The runner's retry and fallback gates read code and retryable, so both are contract.
  it.each([
    ['AiError', new AiError('config', 'x'), 'config', false, 'AiError'],
    ['AiConfigError', new AiConfigError('x'), 'config', false, 'AiConfigError'],
    ['AiInputInvalidError', new AiInputInvalidError('x', []), 'input_invalid', false, 'AiInputInvalidError'],
    ['AiOutputInvalidError', new AiOutputInvalidError('x'), 'output_invalid', false, 'AiOutputInvalidError'],
    ['AiProviderError', new AiProviderError('x'), 'provider', false, 'AiProviderError'],
    ['AiRateLimitError', new AiRateLimitError('x'), 'rate_limit', true, 'AiRateLimitError'],
    ['AiTimeoutError', new AiTimeoutError('x'), 'timeout', true, 'AiTimeoutError'],
    ['AiBudgetExceededError', new AiBudgetExceededError('k'), 'budget_exceeded', false, 'AiBudgetExceededError'],
    ['AiDisabledError', new AiDisabledError(), 'disabled', false, 'AiDisabledError'],
  ])('%s reports its code, retryability, and name', (_label, error, code, retryable, name) => {
    expect(error.code).toBe(code);
    expect(error.retryable).toBe(retryable);
    expect(error.name).toBe(name);
    expect(error).toBeInstanceOf(AiError);
    expect(error).toBeInstanceOf(Error);
    expect(error.stack).toBeTruthy();
  });

  it('honours an explicit retryable flag on the base error', () => {
    expect(new AiError('provider', 'x', { retryable: true }).retryable).toBe(true);
    expect(new AiError('provider', 'x', { retryable: false }).retryable).toBe(false);
  });

  it('distinguishes an absent cause from a cause of undefined', () => {
    const without = new AiError('provider', 'x');
    const withCause = new AiError('provider', 'x', { cause: 'root' });
    expect('cause' in without).toBe(false);
    expect(withCause.cause).toBe('root');
  });
});

describe('AiRateLimitError', () => {
  it('is a provider error that keeps its own code, since the runner gates on both', () => {
    const error = new AiRateLimitError('slow down', { statusCode: 429 });
    expect(error).toBeInstanceOf(AiProviderError);
    expect(error).toBeInstanceOf(AiError);
    // A parent overwriting this back to 'provider' would collapse two distinct signals.
    expect(error.code).toBe('rate_limit');
    expect(error.statusCode).toBe(429);
    expect(error.retryable).toBe(true);
  });
});

describe('AiProviderError', () => {
  it('lets the caller override the default code', () => {
    expect(new AiProviderError('x', { code: 'timeout' }).code).toBe('timeout');
    expect(new AiProviderError('x').code).toBe('provider');
  });

  it('leaves statusCode undefined when none was given', () => {
    expect(new AiProviderError('x').statusCode).toBeUndefined();
    expect(new AiProviderError('x', { statusCode: 503 }).statusCode).toBe(503);
  });
});

describe('error payloads', () => {
  it('carries validation issues on an input failure', () => {
    const issues = [{ path: ['captureText'], message: 'too short' }];
    expect(new AiInputInvalidError('bad', issues).issues).toBe(issues);
  });

  it('carries the material a caller needs to log or settle an output failure', () => {
    const error = new AiOutputInvalidError('bad', {
      issues: 'not a boolean',
      rawOutput: '{"ok":"yes"}',
      usageConsumed: USAGE,
      cause: new Error('root'),
    });
    expect(error.issues).toBe('not a boolean');
    expect(error.rawOutput).toBe('{"ok":"yes"}');
    expect(error.usageConsumed).toEqual(USAGE);
    expect(error.cause).toBeInstanceOf(Error);
  });

  it('leaves output failure payloads undefined when the caller had none', () => {
    const error = new AiOutputInvalidError('bad');
    expect(error.issues).toBeUndefined();
    expect(error.rawOutput).toBeUndefined();
    expect(error.usageConsumed).toBeUndefined();
  });

  it('names the exhausted budget key by default and yields to an explicit message', () => {
    const fallback = new AiBudgetExceededError('tenant:t1:ai:2026-09');
    expect(fallback.budgetKey).toBe('tenant:t1:ai:2026-09');
    expect(fallback.message).toContain('tenant:t1:ai:2026-09');
    expect(new AiBudgetExceededError('k', 'custom wording').message).toBe('custom wording');
  });
});

describe('ProviderOutputError', () => {
  it('carries the salvage material and the usage already spent', () => {
    const error = new ProviderOutputError('schema enforcement failed', {
      rawText: '```json\n{}\n```',
      issues: 'missing title',
      usage: USAGE,
      cause: new Error('root'),
    });
    expect(error.name).toBe('ProviderOutputError');
    expect(error.rawText).toBe('```json\n{}\n```');
    expect(error.issues).toBe('missing title');
    expect(error.usage).toBe(USAGE);
  });

  it('stays outside the AiError hierarchy so the runner can reach its salvage path', () => {
    // runTask returns early on `error instanceof AiError`; making this one an
    // AiError would skip salvage and repair entirely.
    const error = new ProviderOutputError('x', { usage: USAGE });
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(AiError);
  });

  it('omits cause and rawText when not supplied', () => {
    const error = new ProviderOutputError('x', { usage: USAGE });
    expect('cause' in error).toBe(false);
    expect(error.rawText).toBeUndefined();
  });
});
