import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { text } from './prompt.js';
import { defineAiTask } from './task.js';

const base = {
  id: 'app.task-name',
  version: '1',
  profile: 'fast',
  input: z.object({ note: z.string() }),
  output: z.object({ title: z.string() }),
  instructions: () => 'do the thing',
  render: (input: { note: string }) => [text(input.note)],
};

describe('defineAiTask', () => {
  it('returns the same object it was given, since it only pins generics', () => {
    const definition = defineAiTask(base);
    expect(definition).toBe(base);
  });

  it('requires a dot-namespaced id so ids stay globally unique', () => {
    expect(() => defineAiTask({ ...base, id: 'tasklikethis' })).toThrow('tasklikethis');
    expect(() => defineAiTask({ ...base, id: 'app.nested.task' })).not.toThrow();
  });

  it('requires a version, because id plus version is a run provenance', () => {
    expect(() => defineAiTask({ ...base, version: '' })).toThrow('needs a version');
    expect(() => defineAiTask({ ...base, id: 'app.other', version: '2026-01-01' })).not.toThrow();
  });

  it('preserves every optional policy untouched', () => {
    const definition = defineAiTask({
      ...base,
      cache: { ttlSeconds: 600 },
      fallbackProfile: 'balanced',
      overrides: { temperature: 0.5, maxOutputTokens: 100, timeoutMs: 5000, maxRetries: 1 },
      telemetry: { recordContent: true },
    });
    expect(definition.cache).toEqual({ ttlSeconds: 600 });
    expect(definition.fallbackProfile).toBe('balanced');
    expect(definition.overrides).toEqual({
      temperature: 0.5,
      maxOutputTokens: 100,
      timeoutMs: 5000,
      maxRetries: 1,
    });
    expect(definition.telemetry).toEqual({ recordContent: true });
  });

  it('infers input and output types through to the caller', () => {
    const definition = defineAiTask(base);
    const parsed = definition.input.parse({ note: 'hello' });
    // A compile-time assertion: `note` would not typecheck on an unknown input.
    const note: string = parsed.note;
    expect(note).toBe('hello');
    expect(definition.output.parse({ title: 'T' })).toEqual({ title: 'T' });
  });
});
