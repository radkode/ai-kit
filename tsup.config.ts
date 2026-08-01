import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'core/index': 'src/core/index.ts',
    'spec/index': 'src/spec/index.ts',
    'runner/index': 'src/runner/index.ts',
    'telemetry/index': 'src/telemetry/index.ts',
    'registry/index': 'src/registry/index.ts',
    'eval/index': 'src/eval/index.ts',
    'adapters/memory': 'src/adapters/memory.ts',
    'adapters/upstash': 'src/adapters/upstash.ts',
  },
  format: ['esm'],
  // tsup 8 strips `node:` by default; bare 'crypto' breaks Deno and Workers.
  removeNodeProtocol: false,
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
