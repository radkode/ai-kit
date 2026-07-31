import { z } from 'zod';
import type { Capabilities } from '../core/contracts.js';
import { DEFAULT_CAPABILITIES } from '../core/contracts.js';
import type { AiTaskDefinition } from './task.js';

/**
 * TaskManifest: the explicit JSON projection of a TaskDefinition.
 *
 * A definition holds functions and does not serialize; the manifest is what
 * HTTP endpoints and MCP resources serve to external consumers (the ADR-0004
 * "server-owned spec" wire shape: version + instructions + JSON schemas).
 * Instructions are evaluated for a concrete capability profile at projection
 * time.
 */

export interface TaskManifest {
  id: string;
  version: string;
  profile: string;
  capabilities: Capabilities;
  instructions: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

export function toManifest<In, Out, TRender>(
  definition: AiTaskDefinition<In, Out, TRender>,
  capabilities: Capabilities = DEFAULT_CAPABILITIES,
): TaskManifest {
  return {
    id: definition.id,
    version: definition.version,
    profile: definition.profile,
    capabilities,
    instructions: definition.instructions(capabilities),
    inputSchema: z.toJSONSchema(definition.input),
    outputSchema: z.toJSONSchema(definition.output),
  };
}
