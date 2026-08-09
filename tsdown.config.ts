import { defineConfig } from 'tsdown';

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
  // Keep .js/.d.ts so the package.json exports map stays as-is.
  fixedExtension: false,
  dts: true,
  sourcemap: false,
  clean: true,
  treeshake: true,
});
