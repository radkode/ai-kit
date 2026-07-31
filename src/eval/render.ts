import { DEFAULT_CAPABILITIES, type Capabilities } from '../core/contracts.js';
import { joinParts } from '../spec/prompt.js';
import type { AiTaskDefinition, RenderContext } from '../spec/task.js';

/**
 * Render a definition's full prompt exactly as the runner would send it,
 * without calling any model. This is the deterministic eval surface:
 *
 * - Snapshot the result in vitest; a changed snapshot means the prompt changed,
 *   which must be accompanied by a version bump on the definition.
 * - Feed it to Evalite deterministic cases (schema/fixture assertions).
 */
export function renderTaskPrompt<In, Out, TRender>(
  definition: AiTaskDefinition<In, Out, TRender>,
  input: In,
  options: { capabilities?: Capabilities; render?: TRender } = {},
): string {
  const capabilities = options.capabilities ?? DEFAULT_CAPABILITIES;
  const ctx: RenderContext<TRender> = { data: options.render, capabilities };
  const parsed = definition.input.parse(input);
  const instructions = definition.instructions(capabilities);
  const body = joinParts(definition.render(parsed, ctx));
  return `${instructions}\n\n${body}`;
}
