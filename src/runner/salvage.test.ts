import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { salvageJson } from './salvage.js';

const Triage = z.object({
  title: z.string(),
  priority: z.enum(['low', 'medium', 'high']),
  reason: z.string(),
});

const VALID = { title: 'Email the vendor', priority: 'high' as const, reason: 'blocking' };

/** A literal control byte inside a string value, the classic provider breakage. */
const CONTROL = String.fromCharCode(1);

describe('salvageJson', () => {
  it('accepts a clean response unchanged', () => {
    expect(salvageJson(JSON.stringify(VALID), Triage)).toEqual({ success: true, data: VALID });
  });

  it('tolerates surrounding whitespace', () => {
    expect(salvageJson(`\n\n  ${JSON.stringify(VALID)}  \n`, Triage)).toEqual({
      success: true,
      data: VALID,
    });
  });

  it('strips a markdown code fence, labelled or bare', () => {
    const labelled = salvageJson('```json\n' + JSON.stringify(VALID) + '\n```', Triage);
    const bare = salvageJson('```\n' + JSON.stringify(VALID) + '\n```', Triage);
    expect(labelled).toEqual({ success: true, data: VALID });
    expect(bare).toEqual({ success: true, data: VALID });
  });

  it('digs the object out of surrounding prose', () => {
    const raw = `Here is the triage you asked for:\n${JSON.stringify(VALID)}\nHope that helps!`;
    expect(salvageJson(raw, Triage)).toEqual({ success: true, data: VALID });
  });

  it('recovers a top-level array, in prose or on its own', () => {
    const List = z.array(z.object({ id: z.number() }));
    const items = [{ id: 1 }, { id: 2 }];
    expect(salvageJson(JSON.stringify(items), List)).toEqual({ success: true, data: items });
    expect(salvageJson(`Results: ${JSON.stringify(items)} done`, List)).toEqual({
      success: true,
      data: items,
    });
  });

  it('recovers an object whose string values contain braces', () => {
    const nested = { ...VALID, reason: 'the payload was {"a": 1} shaped' };
    expect(salvageJson(`prose ${JSON.stringify(nested)} more prose`, Triage)).toEqual({
      success: true,
      data: nested,
    });
  });

  it('recovers a nested object rather than stopping at the first closing brace', () => {
    const Wrapper = z.object({ inner: z.object({ deep: z.string() }) });
    const value = { inner: { deep: 'yes' } };
    expect(salvageJson(`answer: ${JSON.stringify(value)}`, Wrapper)).toEqual({
      success: true,
      data: value,
    });
  });

  it('strips raw control characters that make an otherwise good body unparseable', () => {
    const raw = `{"title":"Email the vendor","priority":"high","reason":"block${CONTROL}ing"}`;
    expect(() => JSON.parse(raw)).toThrow();
    expect(salvageJson(raw, Triage)).toEqual({ success: true, data: VALID });
  });

  it('keeps searching past a candidate that parses but fails the schema', () => {
    // The array parses cleanly yet is the wrong shape; the brace span inside it validates.
    const raw = JSON.stringify([VALID]);
    expect(JSON.parse(raw)).toBeInstanceOf(Array);
    expect(salvageJson(raw, Triage)).toEqual({ success: true, data: VALID });
  });

  it('returns the schema-parsed value, so defaults and coercions apply', () => {
    const WithDefault = z.object({ title: z.string(), priority: z.string().default('low') });
    const result = salvageJson('{"title":"T"}', WithDefault);
    expect(result).toEqual({ success: true, data: { title: 'T', priority: 'low' } });
  });

  it('refuses to hand back data that violates the schema', () => {
    // Returning a partial object here would defeat the point of schema enforcement.
    expect(salvageJson('{"title":"T","priority":"urgent","reason":"r"}', Triage)).toEqual({
      success: false,
    });
    expect(salvageJson('{"title":42}', Triage)).toEqual({ success: false });
  });

  it('reports failure rather than throwing, whatever the input', () => {
    for (const raw of ['', '   ', 'no json here at all', '{', '}{', '[', '{"a":', '```json\n{```']) {
      expect(salvageJson(raw, Triage), raw).toEqual({ success: false });
    }
  });
});
