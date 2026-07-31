import { createHash } from 'node:crypto';

/**
 * Deterministic JSON: objects serialized with sorted keys, recursively.
 * Dates, Maps, and Sets are given faithful representations; plain JSON.stringify
 * would collapse Map/Set to {} and make distinct inputs collide in the cache.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Map) {
    return { $map: [...value.entries()].map(([k, v]) => [sortValue(k), sortValue(v)]).sort(pairOrder) };
  }
  if (value instanceof Set) {
    return { $set: [...value.values()].map(sortValue).sort(jsonOrder) };
  }
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = sortValue(record[key]);
    }
    return sorted;
  }
  return value;
}

function jsonOrder(a: unknown, b: unknown): number {
  const sa = JSON.stringify(a) ?? '';
  const sb = JSON.stringify(b) ?? '';
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function pairOrder(a: unknown[], b: unknown[]): number {
  return jsonOrder(a[0], b[0]);
}

/**
 * Cache key for one task run. Everything that shapes the prompt participates:
 * task id + version, model, input, capabilities, and render data. Tenant is
 * part of the hash, which makes cross-tenant cache hits structurally
 * impossible rather than merely avoided.
 */
export function runCacheKey(parts: {
  taskId: string;
  taskVersion: string;
  model: string;
  input: unknown;
  tenantId: string | undefined;
  capabilities: unknown;
  renderData: unknown;
}): string {
  const digest = createHash('sha256')
    .update(
      stableStringify({
        i: parts.taskId,
        v: parts.taskVersion,
        m: parts.model,
        in: parts.input,
        t: parts.tenantId ?? null,
        c: parts.capabilities ?? null,
        r: parts.renderData ?? null,
      }),
    )
    .digest('hex');
  return `aikit:${parts.taskId}:${digest}`;
}
