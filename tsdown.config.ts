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
  // Not `dts: true`: that emits the .d.ts sourceMappingURL comment but drops the map.
  dts: { sourcemap: true },
  sourcemap: true,
  clean: true,
  treeshake: true,
});
