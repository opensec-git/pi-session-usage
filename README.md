# Pi Session Usage

One provider-neutral, cumulative meter for a Pi parent session and its linked descendants. It is passive: it does not replace providers, change routing, inject prompts, or make API calls. Existing CommandCode/OpenRouter provider extensions can remain installed; their own footers remain separate.

## Install and use

```sh
pi install git:github.com/opensec-git/pi-session-usage@v0.1.0
```

This is a private GitHub-hosted Pi package, not a public npm package. Your Git client must have access to `opensec-git/pi-session-usage` (for GitHub CLI users, `gh auth login` then `gh auth setup-git`). For a project-only installation, add `-l` to `pi install`. Local development also supports `pi install /absolute/path/to/pi-session-usage`.

Restart Pi or `/reload`. The footer looks like:

```text
Σ $0.0123 est · 68.4% cache · 43.2 TPS~
```

Those numbers are illustrative, not generated usage. `est` identifies estimated pricing; `~` identifies client-measured streaming TPS. `partial` flags known gaps such as missing prices, unreadable records, or known children without usage.

Commands:

```text
/usage-stats             parent + descendants, cumulative
/usage-stats parent      this session only
/usage-stats children    descendants only
/usage-stats all         all sessions recorded in this Pi agent directory
```

The default is the entire current session tree, not the most recent response and not unrelated sessions. Changing the model does not reset the totals. Retained branches, retries with observable responses, compaction usage, and branch-summary usage remain charged; changing context does not undo spend.

## Metrics

- **Cache hit rate:** `sum(cacheRead) / sum(input + cacheRead + cacheWrite)`. Pi's `input` is uncached input. DeepSeek's raw `prompt_tokens` already includes cache hits. Neither cached tokens nor reasoning tokens are added twice.
- **Estimated cost:** sum of priced request records across the tree, plus child summary estimates where detailed observation is incomplete. Unpriced usage stays unknown, not free. DeepSeek uses the official dated price snapshot; other providers use Pi's supplied cost estimate unless configured otherwise. This extension does not perform OpenRouter invoice reconciliation.
- **TPS~:** `sum(output tokens from timed requests) / sum(their generation seconds)`. Timing runs from first content/reasoning/tool delta to completion. It includes client/network effects and is not server TPS or aggregate fleet throughput. Parallel requests contribute their own durations; tool execution/wait time is not a generation duration. Single-delta, replayed, and summary-only records have no invented TPS. `/usage-stats` shows how many requests have timing.

Only requests with known usage contribute to the cache denominator. Unknown counts and timing coverage are printed in the detailed report. Token-only child summaries can contribute cost/cache totals without contributing TPS. A terminal child summary replaces incomplete detailed coverage for that subtree; the two are never simply added.

## DeepSeek official API

Pi's native DeepSeek provider already maps the API's `prompt_cache_hit_tokens` (or `prompt_tokens_details.cached_tokens`) into `cacheRead`. DeepSeek documents `prompt_tokens = hits + misses`, and final streaming usage includes completion tokens. Its documented chat response does not provide a billed USD amount or server generation duration. See [Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/).

Official USD-per-million-token prices were checked on **2026-09-10** in [Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/):

| Model | Peak input miss | Peak cache hit | Peak output |
| --- | ---: | ---: | ---: |
| deepseek-flash | $0.30 | $0.006 | $1.20 |
| deepseek-v4-pro | $1.32 | $0.044 | $3.96 |

Off-peak rates are half these rates. Peak windows are weekdays 01:00–04:00 and 06:00–10:00 UTC. The snapshot recognizes Flash's documented legacy aliases and the announced Pro-to-Flash billing change at 2026-09-14 04:00 UTC. Request-start time selects the estimate; a start/end price change raises a warning. This is not an invoice: provider billing timing, discounts, and future rate changes can differ.

The bundled snapshot intentionally stops pricing new requests on **2026-09-24**. Stale/unknown model pricing is shown as unavailable rather than silently using old prices. Previously persisted costs are not repriced. Refresh the package or explicitly configure rates below. Official prices are never applied to OpenRouter/CommandCode just because their model name contains DeepSeek.

## Child-session coverage

- Children that load this extension publish their own numeric records. `parentSession` headers associate persistent children; in-memory pi-subagents can also be associated using their documented lifecycle ID/name suffix.
- `@tintinweb/pi-subagents` lifecycle totals provide a fallback for top-level children when message-level observation is incomplete. The documented manager registry can supply a persistent child transcript for verified import.
- **Pricing limitation:** a summary-only child (no meter records and no importable transcript) contributes Tintinweb/Pi's supplied cost estimate. Its aggregate summary does not expose per-request model/time information, so the meter cannot independently apply the latest DeepSeek peak/off-peak schedule to that fallback. For independently repriced child usage, load the meter in the child or retain its importable session. Cache counts still roll up from the summary.
- `second_opinion_agent` results and `/second-opinion` custom messages can import their completed child transcript after verifying its parent header. This gives completed-child cost/cache totals without weakening the reviewer's isolation. It cannot reconstruct live TPS or display those uninstrumented child tokens before completion; tool-invoked reviews are marked as known pending children meanwhile.
- Independent Pi processes share the metrics directory and link through parent headers. Custom in-memory SDK children should use the adapter below. A process without a header can set `PI_USAGE_PARENT_SESSION_ID` to its actual parent's session ID.
- An uninstrumented child without a lifecycle summary, verifiable transcript, or explicit link is invisible. Nested agents with no lineage need explicit integration. “Universal” describes provider-neutral accounting, not omniscient discovery of every arbitrary subprocess.

For a custom spawner, emit an explicit link:

```js
pi.events.emit("session-usage:link", { sessionId: childId, parentSessionId: parentId });
```

For an SDK child with extensions disabled, import `attachSession` from this package's `src/observer.mjs` and use:

```js
const detachUsage = await attachSession(childSession, {
  agentDir: sdk.getAgentDir(),
  parentSessionId: parent.sessionManager.getSessionId(),
});
try {
  await childSession.prompt(task);
} finally {
  await detachUsage();
  childSession.dispose();
}
```

This attaches telemetry only: no tools, context, memory, or provider changes.

## Price overrides and persistence

Optional `~/.pi/agent/session-usage-prices.json` maps exact `provider/model` IDs to USD-per-million-token rates:

```json
{
  "your-provider/your-model": {
    "input": 0.3,
    "cacheRead": 0.006,
    "cacheWrite": 0,
    "output": 1.2
  }
}
```

These fixed overrides supersede the built-in schedule and must be maintained by you. `/reload` reloads them. Pi's custom agent-directory setting is respected.

Append-only numeric journals live in `<agent-dir>/session-usage/v1/`. Each process writes its own file; readers incrementally merge records by request ID. There is no rolling 100-message/10,000-record cap that silently drops earlier spend. Keys, prompts, responses, tool arguments, and summaries are not persisted by this meter. Session IDs, lineage paths, model names, usage, estimates, and timing metadata are persisted privately (directory 0700, files 0600). Existing Pi transcripts are read only for the relevant session/verified child; their text is not copied into telemetry.

Metrics are observational: hidden SDK/provider retries and summary calls with no exposed usage cannot be fully priced. Missing usage or price data does not prove zero billing.

## Verification

```sh
npm ci
npm run check
npm run test:pi
npm run test:tintin
```

The Pi integration test uses a local fake DeepSeek-format SSE API, a real Pi CLI parent, and two parallel SDK children. No real API credentials or paid requests are needed. It checks 3,000 total prompt tokens, 2,000 cache hits (66.7%), 60 output tokens, an estimated $0.000384 at fixture rates, and timing for all three requests. It validates runtime integration and arithmetic, not a live DeepSeek bill.

Other tests cover nested aggregation, duplicate/replayed events, partial child-summary replacement, interrupted journal writes, parent validation, single-chunk timing, compaction/restart persistence, peak/off-peak boundaries, price expiry, and secret-free telemetry.

### Tintinweb integration checked 2026-09-10

Tested with Pi **0.85.0** and `@tintinweb/pi-subagents` **0.19.0**, using the real model-invoked `Agent` tool (not a mocked tool or a direct SDK substitute). Eight scenarios cover foreground calls and default background calls, each with:

| Child configuration | Cost and cumulative cache | Child TPS |
| --- | --- | --- |
| Meter loaded, saved session | Pass | Observed |
| Meter loaded, in-memory session | Pass | Observed |
| Extensions disabled, saved session | Pass at completion | Unavailable |
| Extensions disabled, in-memory session | Pass via completion summary | Unavailable |

All scenarios enable Tintinweb's `reportUsage` to check that tool-result usage does not double-count the child records. Each parent calls two children; foreground totals are 4,000 prompt tokens, 2,900 cache hits (**72.5%**), 70 output tokens and **$0.0004314** at fixture rates. Background assertions also account for every parent request triggered by completion notifications. No missing costs, missing usage, unknown children or warnings were observed in these tests.

The test uses an isolated temporary Pi configuration and a local fake DeepSeek-format streaming API. It neither changes your installed plugins/settings nor contacts a paid provider. It verifies accounting and timing collection, not live DeepSeek billing or real model speed. These integration cases cover direct children, not every nested/resumed/cancelled Tintinweb workflow. To measure child TPS in normal use, the child must load the meter; launching the parent with `-e` alone does not guarantee child inheritance when its extension allowlist excludes the meter.

`test:tintin` reads the installed package at `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents`; set `PI_SUBAGENTS_PACKAGE_DIR` to test another installation. The harness waits for completion and takes its final snapshot at shutdown so delayed background notifications are counted.
