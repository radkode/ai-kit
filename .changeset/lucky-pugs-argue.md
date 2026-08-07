---
'@radkode/ai-kit': minor
---

Add Fable 5 and Mythos 5 to the model registry, and fix unknown-model pricing.

Both price at $10/$50 per MTok, above the $5/$25 that `UNKNOWN_MODEL_PRICING` used
as its "most expensive known tier" fallback. Any model id missing from the table
was therefore costed at half the top rate, so USD budget enforcement under-counted
for it: a $50 budget would authorize five times a run that the budget only covers
two and a half times over. The fallback now tracks the real top tier, and a
regression test pins it there.
