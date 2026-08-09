---
'@radkode/ai-kit': patch
---

Build with tsdown on TypeScript 7. The public type surface is unchanged, but the
bundler swap reorganizes the emitted JS and shared chunk names, and sourcemaps
are no longer published (the emitted JS is unminified and annotated with its
source file, so the maps were mostly paying for themselves in tarball size).
