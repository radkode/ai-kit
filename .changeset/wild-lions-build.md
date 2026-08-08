---
'@radkode/ai-kit': patch
---

Build with tsdown on TypeScript 7. The public type surface is unchanged, but the
bundler swap reorganizes the emitted JS and shared chunk names, and `.d.ts.map`
files are now published alongside the declarations.
