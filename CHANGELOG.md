# @radkode/ai-kit

## 0.2.0

### Minor Changes

- a2e8c52: Subpath-only exports: one module, one subpath, one specifier.

  The root `.` export is removed. Import from the module subpath instead: errors
  and contracts from `/core`, `defineAiTask`/`text`/`xml`/`joinParts`/`toManifest`
  from `/spec`, `runTask`/`salvageJson`/`runCacheKey`/`stableStringify` from
  `/runner`, event types from `/telemetry`, and model metadata and profiles from
  the new `/registry`.

  `resetProvider` moves from `/core` to `/runner`, which leaves `/core` free of
  runtime dependencies: it no longer pulls the Anthropic SDK into consumers that
  only wanted the typed errors.

  Also adds a `./package.json` export, and stops the build from stripping the
  `node:` prefix off builtin imports (bare `crypto` broke Deno and Workers).

## 0.1.0

### Minor Changes

- 68e310a: Phase 0 kernel: task definitions with wire-safe manifests, provider-wrapped runner with schema-enforced output and salvage/repair, two-phase token+dollar budgets (memory + Upstash), named profiles with env overrides, tenant-namespaced caching, metadata-only telemetry, typed errors, and deterministic eval scaffolding.
