import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'core/index': 'src/core/index.ts',
    'spec/index': 'src/spec/index.ts',
    'runner/index': 'src/runner/index.ts',
    'telemetry/index': 'src/telemetry/index.ts',
    'eval/index': 'src/eval/index.ts',
    'adapters/memory': 'src/adapters/memory.ts',
    'adapters/upstash': 'src/adapters/upstash.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
});
