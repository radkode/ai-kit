import { LuaFactory } from 'wasmoon';

/**
 * A Redis stand-in that executes the adapter's Lua scripts for real.
 *
 * The Upstash budget adapter's actual logic (limit arithmetic, the stale
 * reservation sweep, idempotent settlement) lives in Lua, so a fake that only
 * recorded eval() calls would assert nothing. This bridges redis.call into a
 * Map-backed store and runs the scripts in a Lua VM.
 *
 * wasmoon is Lua 5.4 while Redis embeds 5.1; the constructs these scripts use
 * (string.match, tonumber, integer concatenation) behave identically in both.
 */

// The factory compiles the wasm module once and is reused across engines.
const factory = new LuaFactory();

export interface FakeRedis {
  get(key: string): Promise<unknown>;
  set(key: string, value: string, options?: { ex?: number }): Promise<unknown>;
  eval(script: string, keys: string[], args: unknown[]): Promise<unknown>;
  /** Plant a value the client would hand back already deserialized. */
  seedRaw(key: string, value: unknown): void;
  /** Read a hash's live entries, for asserting the reservation ledger directly. */
  hash(key: string): Map<string, string>;
  strings(): Map<string, unknown>;
  /** Commands the scripts asked for, in order, for asserting which keys were touched. */
  commands(): string[][];
  close(): void;
}

export function createFakeRedis(): FakeRedis {
  const strings = new Map<string, unknown>();
  const hashes = new Map<string, Map<string, string>>();
  const commands: string[][] = [];
  let engine: Awaited<ReturnType<typeof factory.createEngine>> | undefined;

  function call(rawCmd: unknown, ...args: unknown[]): unknown {
    const cmd = String(rawCmd).toUpperCase();
    commands.push([cmd, ...args.map(String)]);
    const key = String(args[0]);
    switch (cmd) {
      case 'HGETALL':
        // Redis returns a flat field, value, field, value array.
        return [...(hashes.get(key) ?? new Map()).entries()].flat();
      case 'HDEL': {
        const hash = hashes.get(key);
        if (!hash) return 0;
        return hash.delete(String(args[1])) ? 1 : 0;
      }
      case 'HSET': {
        const hash = hashes.get(key) ?? new Map<string, string>();
        hashes.set(key, hash);
        hash.set(String(args[1]), String(args[2]));
        return 1;
      }
      case 'GET':
        // Returning null crashes wasmoon's value bridge; undefined maps to nil,
        // which is what the scripts' `or '0'` fallback expects.
        return strings.has(key) ? strings.get(key) : undefined;
      case 'INCRBY': {
        const next = Number(strings.get(key) ?? 0) + Number(args[1]);
        strings.set(key, String(next));
        return next;
      }
      case 'EXPIRE':
        return 1;
      default:
        throw new Error(`fake-redis: unsupported command ${cmd}`);
    }
  }

  async function lua() {
    if (!engine) {
      engine = await factory.createEngine();
      engine.global.set('__redis_call', call);
      await engine.doString('redis = { call = function(...) return __redis_call(...) end }');
    }
    return engine;
  }

  return {
    async get(key) {
      return strings.has(key) ? strings.get(key) : null;
    },
    async set(key, value, options) {
      commands.push(['SET', key, value, JSON.stringify(options ?? null)]);
      strings.set(key, value);
      return 'OK';
    },
    async eval(script, keys, args) {
      const vm = await lua();
      vm.global.set('KEYS', keys);
      vm.global.set('ARGV', args.map(String));
      return await vm.doString(script);
    },
    seedRaw(key, value) {
      strings.set(key, value);
    },
    hash(key) {
      return hashes.get(key) ?? new Map();
    },
    strings() {
      return strings;
    },
    commands() {
      return commands;
    },
    close() {
      engine?.global.close();
      engine = undefined;
    },
  };
}
