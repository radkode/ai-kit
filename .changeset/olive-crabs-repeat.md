---
'@radkode/ai-kit': minor
---

Raise the supported Node floor to `>=24`.

`engines` claimed `>=20`, but every workflow has only ever run Node 24 and
`@types/node` is pinned to `^24`, so nothing verified the old floor at runtime or
at type-check time. The declared range now matches what is actually tested.

This is breaking for consumers on Node 20 or 22. Pre-1.0, that ships as a minor.
