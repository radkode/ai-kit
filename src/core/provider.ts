import { createAnthropic } from '@ai-sdk/anthropic';
import {
  APICallError,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  RetryError,
  generateText,
  type LanguageModelUsage,
  type ModelMessage,
} from 'ai';
import type { z } from 'zod';
import type { AiUsage } from './contracts.js';
import { AiConfigError, AiError, AiProviderError, AiRateLimitError, AiTimeoutError } from './errors.js';
import type { ModelInfo } from '../registry/models.js';
import type { Profile } from '../registry/profiles.js';
import type { PromptPart } from '../spec/prompt.js';

/**
 * The ONLY module in the estate that imports the AI SDK. Apps import ai-kit;
 * an eslint no-restricted-imports rule bans 'ai', '@ai-sdk/*', and provider
 * SDKs everywhere else. Keeping the SDK surface confined to this file is what
 * makes the provider layer swappable.
 *
 * SDK telemetry note: content recording is disabled here unconditionally
 * (recordInputs/recordOutputs false); ai-kit's own metadata-only events are
 * the default observability signal. Set AI_SDK_TELEMETRY=true to emit AI SDK
 * OTel spans (still metadata-only) into whatever exporter the app configured.
 */

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

export interface GenerateStructuredArgs<Out> {
  model: ModelInfo;
  profile: Profile;
  instructions: string;
  parts: PromptPart[];
  outputSchema: z.ZodType<Out>;
  taskId?: string;
}

export interface GenerateStructuredResult<Out> {
  output: Out;
  usage: AiUsage;
}

let anthropicProvider: ReturnType<typeof createAnthropic> | undefined;

function languageModel(model: ModelInfo) {
  if (model.provider !== 'anthropic') {
    throw new AiConfigError(`Unsupported provider "${model.provider}" for model ${model.id}`);
  }
  if (!anthropicProvider) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new AiConfigError('ANTHROPIC_API_KEY is not set');
    anthropicProvider = createAnthropic({ apiKey });
  }
  return anthropicProvider(model.id);
}

/** Test seam: replace or clear the provider instance. */
export function resetProvider(): void {
  anthropicProvider = undefined;
}

const CACHE_CONTROL = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/**
 * Map prompt parts to one user message. Anthropic prompt caching is a prefix
 * mechanism, so a single breakpoint on the LAST cacheable part caches the
 * whole prefix before it (system instructions included).
 */
function toMessages(parts: PromptPart[]): ModelMessage[] {
  const lastCacheable = parts.reduce((last, part, i) => (part.cacheable ? i : last), -1);
  return [
    {
      role: 'user',
      content: parts.map((part, i) => ({
        type: 'text' as const,
        text: part.text,
        ...(i === lastCacheable ? { providerOptions: CACHE_CONTROL } : {}),
      })),
    },
  ];
}

function toUsage(usage: LanguageModelUsage | undefined): AiUsage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cachedInputTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
    cacheWriteInputTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
  };
}

function sdkTelemetry(taskId: string | undefined) {
  if (process.env.AI_SDK_TELEMETRY !== 'true') return {};
  return {
    experimental_telemetry: {
      isEnabled: true,
      recordInputs: false,
      recordOutputs: false,
      ...(taskId ? { functionId: taskId } : {}),
    },
  };
}

export async function generateStructured<Out>(
  args: GenerateStructuredArgs<Out>,
): Promise<GenerateStructuredResult<Out>> {
  const { model, profile, instructions, parts, outputSchema } = args;

  try {
    const result = await generateText({
      model: languageModel(model),
      system: instructions,
      messages: toMessages(parts),
      output: Output.object({ schema: outputSchema }),
      maxRetries: profile.maxRetries,
      abortSignal: AbortSignal.timeout(profile.timeoutMs),
      ...(model.supportsTemperature && profile.temperature !== undefined
        ? { temperature: profile.temperature }
        : {}),
      maxOutputTokens: profile.maxOutputTokens,
      ...sdkTelemetry(args.taskId),
    });
    return { output: result.output, usage: toUsage(result.usage) };
  } catch (error) {
    throw mapProviderError(error);
  }
}

export interface GenerateTextArgs {
  model: ModelInfo;
  profile: Profile;
  instructions: string;
  parts: PromptPart[];
  taskId?: string;
}

export async function generatePlainText(args: GenerateTextArgs): Promise<{ text: string; usage: AiUsage }> {
  const { model, profile, instructions, parts } = args;
  try {
    const result = await generateText({
      model: languageModel(model),
      system: instructions,
      messages: toMessages(parts),
      maxRetries: profile.maxRetries,
      abortSignal: AbortSignal.timeout(profile.timeoutMs),
      ...(model.supportsTemperature && profile.temperature !== undefined
        ? { temperature: profile.temperature }
        : {}),
      maxOutputTokens: profile.maxOutputTokens,
      ...sdkTelemetry(args.taskId),
    });
    return { text: result.text, usage: toUsage(result.usage) };
  } catch (error) {
    throw mapProviderError(error);
  }
}

function mapProviderError(error: unknown): Error {
  if (error instanceof AiError) return error;
  if (NoObjectGeneratedError.isInstance(error)) {
    // Truncation is not a schema problem: salvage cannot complete a cut-off
    // JSON body and a repair call would truncate again. Fail with guidance.
    if (error.finishReason === 'length') {
      return new AiProviderError(
        'Output truncated at maxOutputTokens before completing; raise the profile maxOutputTokens or shrink the task output',
        { retryable: false, cause: error },
      );
    }
    return new ProviderOutputError('Model output failed schema enforcement', {
      ...(error.text !== undefined ? { rawText: error.text } : {}),
      issues: error.cause instanceof Error ? error.cause.message : error.cause,
      usage: toUsage(error.usage),
      cause: error,
    });
  }
  if (NoOutputGeneratedError.isInstance(error)) {
    return new AiProviderError('Provider produced no output', { retryable: true, cause: error });
  }
  const apiError = unwrapApiCallError(error);
  if (apiError) {
    if (apiError.statusCode === 429) {
      return new AiRateLimitError(apiError.message, { statusCode: 429, cause: error });
    }
    return new AiProviderError(apiError.message, {
      ...(apiError.statusCode !== undefined ? { statusCode: apiError.statusCode } : {}),
      retryable: apiError.isRetryable,
      cause: error,
    });
  }
  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new AiTimeoutError('Provider call timed out', { cause: error });
  }
  if (error instanceof Error) {
    return new AiProviderError(error.message, { cause: error });
  }
  return new AiProviderError(String(error));
}

function unwrapApiCallError(error: unknown): APICallError | undefined {
  if (APICallError.isInstance(error)) return error;
  if (RetryError.isInstance(error) && APICallError.isInstance(error.lastError)) {
    return error.lastError;
  }
  return undefined;
}
