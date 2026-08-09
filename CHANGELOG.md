# @radkode/ai-kit

## 0.3.1

### Patch Changes

- b050475: Build with tsdown on TypeScript 7. The public type surface is unchanged, but the
  bundler swap reorganizes the emitted JS and shared chunk names, and sourcemaps
  are no longer published (the emitted JS is unminified and annotated with its
  source file, so the maps were mostly paying for themselves in tarball size).

## 0.3.0

### Minor Changes

- 07b1088: Add Fable 5 and Mythos 5 to the model registry, and fix unknown-model pricing.

  Both price at $10/$50 per MTok, above the $5/$25 that `UNKNOWN_MODEL_PRICING` used
  as its "most expensive known tier" fallback. Any model id missing from the table
  was therefore costed at half the top rate, so USD budget enforcement under-counted
  for it: a $50 budget would authorize five times a run that the budget only covers
  two and a half times over. The fallback now tracks the real top tier, and a
  regression test pins it there.

- 789c301: Raise the supported Node floor to `>=24`.

  `engines` claimed `>=20`, but every workflow has only ever run Node 24 and
  `@types/node` is pinned to `^24`, so nothing verified the old floor at runtime or
  at type-check time. The declared range now matches what is actually tested.

  This is breaking for consumers on Node 20 or 22. Pre-1.0, that ships as a minor.

- cac5272: Upgrade to `ai` v7 and `@ai-sdk/anthropic` v4.

  The two move together: v7 and v4 both pin `@ai-sdk/provider@4.0.6` and
  `@ai-sdk/provider-utils@5.0.23`, so bumping either alone splits the provider graph.
  The zod peer range is unchanged.

  The only source change is `experimental_telemetry` to `telemetry`, which v7
  deprecates with a removal scheduled for a future major. Same option shape, same
  `AI_SDK_TELEMETRY=true` env gate. No public API change.

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
