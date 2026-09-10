import { createHash } from "node:crypto";
import { costFor } from "./pricing.mjs";
export const finite = value => typeof value === "number" && Number.isFinite(value) && value >= 0;
export const hash = value => createHash("sha256").update(value).digest("hex").slice(0, 32);

// Pi input excludes cacheRead/cacheWrite; raw DeepSeek prompt_tokens includes hits.
export function normalizeUsage(value) {
  if (!value || typeof value !== "object") return undefined;
  if (finite(value.prompt_tokens)) {
    const cacheRead = value.prompt_cache_hit_tokens ?? value.prompt_tokens_details?.cached_tokens;
    if (!finite(cacheRead) || cacheRead > value.prompt_tokens || !finite(value.completion_tokens)) return undefined;
    const input = value.prompt_tokens - cacheRead;
    if (value.prompt_cache_miss_tokens !== undefined && value.prompt_cache_miss_tokens !== input) return undefined;
    return { input, cacheRead, cacheWrite: 0, output: value.completion_tokens };
  }
  if (!["input", "output", "cacheRead", "cacheWrite"].every(key => finite(value[key]))) return undefined;
  return Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, value[key]]));
}
export function makeRecord(message, sessionId, { model, startedAt, firstTokenAt, endedAt = Date.now(), overrides = {} } = {}) {
  if (message?.role !== "assistant") return undefined;
  const timestamp = finite(message.timestamp) ? message.timestamp : endedAt;
  const usage = normalizeUsage(message.usage);
  // Initial zero-filled error usage does not prove a failed request was free.
  const emptyFailure = ["error", "aborted"].includes(message.stopReason) && usage && Object.values(usage).every(value => value === 0);
  const knownUsage = emptyFailure ? undefined : usage;
  const id = message.responseId ? `${message.provider}:${message.responseId}`
    : `${sessionId}:${timestamp}:${hash(JSON.stringify([message.provider, message.model, message.usage]))}`;
  const durationMs = finite(firstTokenAt) && endedAt > firstTokenAt && knownUsage?.output > 0 ? endedAt - firstTokenAt : undefined;
  return { type: "request", id, sessionId, timestamp, provider: message.provider, model: message.model,
    ...knownUsage, usageKnown: Boolean(knownUsage), status: message.stopReason || "unknown",
    ...costFor(message, knownUsage || {}, model, startedAt ?? timestamp, endedAt, overrides),
    generationMs: durationMs, ttftMs: finite(startedAt) && finite(firstTokenAt) && firstTokenAt >= startedAt ? firstTokenAt - startedAt : undefined,
    timingSource: durationMs === undefined ? "unavailable" : "client-stream", observedAt: Date.now() };
}

export class Ledger {
  sessions = new Map();
  requests = new Map();
  children = new Map();
  errors = new Set();
  apply(event) {
    if (!event || typeof event !== "object") return;
    if (event.type === "session" && typeof event.id === "string") {
      const previous = this.sessions.get(event.id);
      this.sessions.set(event.id, { ...previous, ...event, parentId: event.parentId || previous?.parentId, file: event.file || previous?.file });
    } else if (event.type === "request" && typeof event.id === "string" && typeof event.sessionId === "string") {
      const old = this.requests.get(event.id);
      // Rehydration supplies no timings. Never replace live measurements with a replay.
      if (!old || event.observedAt >= old.observedAt) this.requests.set(event.id, { ...event, sessionId: old?.sessionId || event.sessionId,
        generationMs: event.generationMs ?? old?.generationMs, ttftMs: event.ttftMs ?? old?.ttftMs });
    } else if (event.type === "child" && typeof event.id === "string" && typeof event.parentId === "string") {
      this.children.set(event.id, { ...this.children.get(event.id), ...event });
    }
  }
  parentOf(id) {
    const session = this.sessions.get(id);
    if (session?.parentId) return session.parentId;
    if (session?.parentFile) return [...this.sessions.values()].find(other => other.file === session.parentFile)?.id;
    if (session?.agentId) return this.children.get(session.agentId)?.parentId;
    if (session?.agentShortId) {
      const matches = [...this.children.values()].filter(child => child.id.startsWith(session.agentShortId));
      if (matches.length === 1) return matches[0].parentId;
    }
    return undefined;
  }
  descendants(rootId) {
    const ids = new Set([rootId]);
    for (let changed = true; changed;) {
      changed = false;
      for (const id of this.sessions.keys()) if (!ids.has(id) && ids.has(this.parentOf(id))) { ids.add(id); changed = true; }
    }
    return ids;
  }
  summarize(rootId, mode = "tree") {
    const ids = mode === "all" ? new Set(this.sessions.keys()) : mode === "parent" ? new Set([rootId]) : this.descendants(rootId);
    if (mode === "children") ids.delete(rootId);
    let records = [...this.requests.values()].filter(record => ids.has(record.sessionId));
    let summaryChildren = 0, unknownChildren = 0;
    // Terminal child summaries are authoritative totals when message-level coverage
    // is incomplete. Replace that child's observed subtree, never add both totals.
    const replaced = new Set();
    const depth = id => { const seen = new Set(); while (this.parentOf(id) && !seen.has(id)) { seen.add(id); id = this.parentOf(id); } return seen.size; };
    for (const child of [...this.children.values()].sort((a, b) => depth(a.parentId) - depth(b.parentId))) {
      if (child.status === "not-started") continue;
      if (replaced.has(child.parentId)) continue;
      if (!ids.has(child.parentId) && !(mode === "children" && child.parentId === rootId)) continue;
      if (mode === "parent") continue;
      const sessions = [...this.sessions.values()].filter(session => session.agentId === child.id || (session.agentShortId && child.id.startsWith(session.agentShortId)));
      const subtree = new Set(sessions.flatMap(session => [...this.descendants(session.id)]));
      const direct = records.filter(record => subtree.has(record.sessionId));
      const usage = normalizeUsage(child.usage);
      const fullyObserved = direct.length > 0 && (!usage || direct.every(record => record.usageKnown)
        && ["input", "output", "cacheRead", "cacheWrite"].every(key => direct.reduce((sum, r) => sum + r[key], 0) >= usage[key]));
      if (usage && !fullyObserved) {
        for (const id of subtree) replaced.add(id);
        records = records.filter(record => !subtree.has(record.sessionId));
        const cost = child.usage?.cost?.total;
        records.push({ id: `child:${child.id}`, sessionId: `child:${child.id}`, ...usage, usageKnown: true,
          costUsd: finite(cost) && cost > 0 ? cost : undefined, costSource: "child-summary-estimate", status: child.status });
        summaryChildren++;
      } else if (!fullyObserved) unknownChildren++;
    }
    const known = records.filter(record => record.usageKnown);
    const total = key => known.reduce((sum, record) => sum + record[key], 0);
    const promptTokens = total("input") + total("cacheRead") + total("cacheWrite");
    const timed = records.filter(record => finite(record.generationMs) && record.generationMs > 0 && finite(record.output));
    const generationMs = timed.reduce((sum, record) => sum + record.generationMs, 0);
    const priced = records.filter(record => finite(record.costUsd));
    return { records, sessions: ids.size, requests: records.length - summaryChildren, summaryChildren, unknownChildren,
      promptTokens, output: total("output"), cacheRead: total("cacheRead"), cacheWrite: total("cacheWrite"), input: total("input"),
      cacheHitRate: promptTokens ? total("cacheRead") / promptTokens : undefined,
      costUsd: priced.reduce((sum, record) => sum + record.costUsd, 0), unpriced: records.length - priced.length,
      unknownUsage: records.length - known.length, timedRequests: timed.length,
      tps: generationMs > 0 ? timed.reduce((sum, record) => sum + record.output, 0) / (generationMs / 1000) : undefined,
      warnings: [...this.errors, ...new Set(records.map(record => record.pricingWarning).filter(Boolean))] };
  }
}
export function footer(summary) {
  const cost = `${summary.unpriced ? "≥" : ""}$${summary.costUsd.toFixed(4)} est`;
  const cache = summary.cacheHitRate === undefined ? "cache n/a" : `${(summary.cacheHitRate * 100).toFixed(1)}% cache`;
  const tps = summary.tps === undefined ? "TPS n/a" : `${summary.tps.toFixed(1)} TPS~`;
  const limited = summary.unpriced || summary.unknownUsage || summary.unknownChildren || summary.warnings.length;
  return `Σ ${cost} · ${cache} · ${tps}${limited ? " · partial" : ""}`;
}
export function report(summary, scope) {
  return `${scope} (cumulative)\n${footer(summary)}\n` +
    `${summary.requests} observed requests; ${summary.summaryChildren} child summaries; ${summary.sessions} linked sessions\n` +
    `${summary.input} new input + ${summary.cacheRead} cache read + ${summary.cacheWrite} cache write = ${summary.promptTokens} prompt tokens; ${summary.output} output\n` +
    `Unknown: ${summary.unpriced} costs, ${summary.unknownUsage} usages, ${summary.unknownChildren} known children. TPS covers ${summary.timedRequests} requests.\n` +
    `TPS~ is a client-stream estimate; overlapping child requests use summed generation time, not wall-clock fleet throughput. Cost is not a billing invoice.\n` + summary.warnings.join("\n");
}
