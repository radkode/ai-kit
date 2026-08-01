/**
 * Typed error taxonomy for every failure ai-kit can surface.
 *
 * The runner never swallows failures into silent heuristic fallbacks; it throws
 * one of these and the calling app decides what degrades. `retryable` tells the
 * caller (and the runner's own retry loop) whether trying again can help.
 */

import type { AiUsage } from './contracts.js';

export type AiErrorCode =
  | 'config'
  | 'input_invalid'
  | 'output_invalid'
  | 'provider'
  | 'rate_limit'
  | 'timeout'
  | 'budget_exceeded'
  | 'disabled';

export class AiError extends Error {
  readonly code: AiErrorCode;
  readonly retryable: boolean;

  constructor(
    code: AiErrorCode,
    message: string,
    options: { retryable?: boolean; cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AiError';
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export class AiConfigError extends AiError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('config', message, options);
    this.name = 'AiConfigError';
  }
}

export class AiInputInvalidError extends AiError {
  readonly issues: unknown;

  constructor(message: string, issues: unknown) {
    super('input_invalid', message);
    this.name = 'AiInputInvalidError';
    this.issues = issues;
  }
}

/** The model's output failed schema validation even after the repair pass. */
export class AiOutputInvalidError extends AiError {
  readonly issues: unknown;
  /** Raw model text, kept so callers can log or salvage it. */
  readonly rawOutput: string | undefined;
  /** Tokens consumed by the failed attempt(s); the runner settles budgets from this. */
  readonly usageConsumed: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number } | undefined;

  constructor(
    message: string,
    options: {
      issues?: unknown;
      rawOutput?: string;
      cause?: unknown;
      usageConsumed?: { inputTokens: number; outputTokens: number; cachedInputTokens: number; cacheWriteInputTokens: number };
    } = {},
  ) {
    super('output_invalid', message, { cause: options.cause });
    this.name = 'AiOutputInvalidError';
    this.issues = options.issues;
    this.rawOutput = options.rawOutput;
    this.usageConsumed = options.usageConsumed;
  }
}

export class AiProviderError extends AiError {
  readonly statusCode: number | undefined;

  constructor(
    message: string,
    options: { statusCode?: number; retryable?: boolean; cause?: unknown; code?: AiErrorCode } = {},
  ) {
    super(options.code ?? 'provider', message, options);
    this.name = 'AiProviderError';
    this.statusCode = options.statusCode;
  }
}

export class AiRateLimitError extends AiProviderError {
  constructor(message: string, options: { statusCode?: number; cause?: unknown } = {}) {
    super(message, { ...options, retryable: true, code: 'rate_limit' });
    this.name = 'AiRateLimitError';
  }
}

export class AiTimeoutError extends AiError {
  constructor(message: string, options: { cause?: unknown } = {}) {
    super('timeout', message, { retryable: true, cause: options.cause });
    this.name = 'AiTimeoutError';
  }
}

export class AiBudgetExceededError extends AiError {
  readonly budgetKey: string;

  constructor(budgetKey: string, message?: string) {
    super('budget_exceeded', message ?? `AI budget exhausted for key "${budgetKey}"`);
    this.name = 'AiBudgetExceededError';
    this.budgetKey = budgetKey;
  }
}

/** AI is switched off (AI_DISABLED) — callers decide what the degraded path is. */
export class AiDisabledError extends AiError {
  constructor() {
    super('disabled', 'AI is disabled via configuration');
    this.name = 'AiDisabledError';
  }
}

/** Raised when the model's output failed schema enforcement; carries salvage material. */
export class ProviderOutputError extends Error {
  readonly rawText: string | undefined;
  readonly issues: unknown;
  readonly usage: AiUsage;

  constructor(message: string, options: { rawText?: string; issues?: unknown; usage: AiUsage; cause?: unknown }) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProviderOutputError';
    this.rawText = options.rawText;
    this.issues = options.issues;
    this.usage = options.usage;
  }
}
