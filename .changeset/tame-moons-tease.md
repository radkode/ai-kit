---
'@radkode/ai-kit': minor
---

Upgrade to `ai` v7 and `@ai-sdk/anthropic` v4.

The two move together: v7 and v4 both pin `@ai-sdk/provider@4.0.6` and
`@ai-sdk/provider-utils@5.0.23`, so bumping either alone splits the provider graph.
The zod peer range is unchanged.

The only source change is `experimental_telemetry` to `telemetry`, which v7
deprecates with a removal scheduled for a future major. Same option shape, same
`AI_SDK_TELEMETRY=true` env gate. No public API change.
