import { join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { makeRecord, footer, report } from "./core.mjs";
import { sharedStore, sessionHeader, loadOverrides } from "./store.mjs";

export class Observer {
  constructor(agentDir, parentId) {
    this.agentDir = agentDir;
    this.parentId = parentId;
    this.store = sharedStore(join(agentDir, "session-usage", "v1"));
    this.off = [];
    this.pendingImports = new Set();
  }
  async start(ctx) {
    this.ctx = ctx;
    this.id = ctx.sessionManager.getSessionId();
    const header = ctx.sessionManager.getHeader?.();
    const file = ctx.sessionManager.getSessionFile?.();
    const parent = await sessionHeader(header?.parentSession);
    const name = ctx.sessionManager.getSessionName?.() || "";
    const agentShortId = name.match(/#([a-zA-Z0-9_-]{8,})$/)?.[1];
    await this.store.write({ type: "session", id: this.id, file: file ? resolve(file) : undefined,
      parentId: this.parentId || parent?.id, parentFile: header?.parentSession ? resolve(header.parentSession) : undefined, agentShortId });
    try { this.overrides = await loadOverrides(this.agentDir); }
    catch { this.overrides = {}; this.store.ledger.errors.add("Invalid session-usage-prices.json; custom prices unavailable"); }
    await this.store.refresh();
    // Rehydrate all retained branches: paid attempts remain spend even after /tree.
    // Existing live records take precedence over replayed timings and estimates.
    for (const entry of ctx.sessionManager.getEntries?.() || []) {
      if (["compaction", "branch_summary"].includes(entry.type)) this.summaryEntry(entry);
      const message = entry.type === "message" ? entry.message : undefined;
      if (message?.toolName === "second_opinion_agent" || message?.customType === "second-opinion-review") {
        if (message.details?.childSessionPath) await this.importChild(message.details.childSessionPath);
      }
      if (message?.role !== "assistant") continue;
      const record = makeRecord(message, this.id, { endedAt: message.timestamp, overrides: this.overrides });
      if (record && !this.store.ledger.requests.has(record.id)) await this.store.write(record);
    }
    this.paint();
    this.timer = setInterval(() => {
      if (this.refreshing) return;
      this.refreshing = this.store.refresh().then(() => this.paint()).finally(() => { this.refreshing = undefined; });
    }, 2000);
    this.timer.unref();
  }
  paint() {
    this.ctx?.ui?.setStatus?.("session-usage", footer(this.store.ledger.summarize(this.id)));
  }
  event(event, ctx = this.ctx) {
    this.ctx = ctx;
    if (event.type === "tool_execution_start" && event.toolName === "second_opinion_agent") {
      this.child({ id: `opinion:${event.toolCallId}` }, "running"); return;
    }
    if (event.type === "tool_execution_end" && event.toolName === "second_opinion_agent" && event.result?.details?.childSessionPath) {
      const id = `opinion:${event.toolCallId}`;
      this.child({ id }, event.result.details.status || "complete");
      this.scheduleImport(event.result.details.childSessionPath, id); return;
    }
    if (event.type === "tool_execution_end" && event.toolName === "second_opinion_agent" && !event.result?.details?.childSessionId) {
      this.child({ id: `opinion:${event.toolCallId}` }, "not-started"); return;
    }
    if (event.type === "message_end" && event.message?.customType === "second-opinion-review" && event.message.details?.childSessionPath) {
      this.scheduleImport(event.message.details.childSessionPath); return;
    }
    if (event.type === "session_compact") this.summaryEntry(event.compactionEntry);
    if (event.type === "session_tree" && event.summaryEntry) this.summaryEntry(event.summaryEntry);
    if (event.type === "before_provider_request") {
      this.startedAt = Date.now(); this.firstTokenAt = undefined; this.deltas = 0;
    }
    if (event.type === "message_start" && event.message?.role === "assistant") {
      this.startedAt ??= Date.now(); this.firstTokenAt = undefined; this.deltas = 0;
    }
    if (event.type === "message_update") {
      const part = event.assistantMessageEvent;
      if (part?.type?.endsWith("_delta") && typeof part.delta === "string" && part.delta.length) {
        this.deltas = (this.deltas || 0) + 1;
        if (this.firstTokenAt === undefined) this.firstTokenAt = Date.now();
      }
    }
    if (event.type === "message_end" && event.message?.role === "assistant") {
      const message = event.message;
      const model = ctx.modelRegistry?.find(message.provider, message.model) || ctx.model;
      const record = makeRecord(message, this.id, { model, startedAt: this.startedAt,
        firstTokenAt: this.deltas >= 2 ? this.firstTokenAt : undefined, endedAt: Date.now(), overrides: this.overrides });
      this.startedAt = undefined; this.firstTokenAt = undefined;
      if (record) { void this.store.write(record); this.paint(); }
    }
  }
  async link(sessionId, parentId = this.id, agentId) {
    if (typeof sessionId !== "string" || typeof parentId !== "string" || sessionId === parentId) return;
    await this.store.write({ type: "session", id: sessionId, parentId, agentId }); this.paint();
  }
  summaryEntry(entry) {
    if (!entry?.id) return;
    const record = makeRecord({ role: "assistant", responseId: `${this.id}:${entry.id}`, provider: "pi-summary",
      model: entry.type, timestamp: Date.parse(entry.timestamp), usage: entry.usage, stopReason: "stop" }, this.id);
    if (record && !this.store.ledger.requests.has(record.id)) void this.store.write(record);
    this.paint();
  }
  scheduleImport(path, agentId) {
    const task = this.importChild(path, agentId).catch(() => { this.store.ledger.errors.add("Child usage import failed"); })
      .finally(() => this.pendingImports.delete(task));
    this.pendingImports.add(task);
  }
  async importChild(path, agentId) {
    const header = await sessionHeader(path);
    const parentFile = this.ctx?.sessionManager.getSessionFile?.();
    if (!header?.parentSession || !parentFile || resolve(header.parentSession) !== resolve(parentFile)) {
      this.store.ledger.errors.add("Child transcript could not be verified against this parent session"); return;
    }
    await this.store.write({ type: "session", id: header.id, file: resolve(path), parentId: this.id, agentId });
    const stream = createReadStream(path);
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        let entry; try { entry = JSON.parse(line); } catch { continue; }
        const message = entry.type === "message" ? entry.message : undefined;
        if (message?.role !== "assistant") continue;
        const record = makeRecord(message, header.id, { model: this.ctx.modelRegistry?.find(message.provider, message.model), endedAt: message.timestamp, overrides: this.overrides });
        if (record && !this.store.ledger.requests.has(record.id)) await this.store.write(record);
      }
    } catch { this.store.ledger.errors.add("Child transcript usage import was incomplete"); }
    finally { lines.close(); stream.destroy(); }
    this.paint();
  }
  child(data, status) {
    if (!data?.id || typeof data.id !== "string") return;
    const usage = data.usage && Object.fromEntries(["input", "output", "cacheRead", "cacheWrite"].map(key => [key, data.usage[key]]));
    if (usage && data.usage.cost) usage.cost = { total: data.usage.cost.total };
    void this.store.write({ type: "child", id: data.id, parentId: this.id, status, ...(usage ? { usage } : {}) });
    const registry = globalThis[Symbol.for("pi-subagents:manager")];
    const file = registry?.getRecord?.(data.id)?.sessionFile;
    if (file && status !== "running") this.scheduleImport(file, data.id);
    this.paint();
  }
  async show(mode = "tree") {
    await this.store.refresh();
    const summary = this.store.ledger.summarize(this.id, mode);
    return report(summary, mode === "tree" ? "Parent + descendants" : mode);
  }
  async stop() {
    clearInterval(this.timer);
    for (const unsubscribe of this.off) unsubscribe?.();
    await Promise.all(this.pendingImports);
    await this.refreshing;
    await this.store.queue;
    this.ctx?.ui?.setStatus?.("session-usage", undefined);
  }
}

/** Explicit integration for SDK children that intentionally disable extensions.
 * Attaches telemetry only; adds no prompts, tools, memory, or model calls.
 */
export async function attachSession(session, { agentDir, parentSessionId }) {
  const observer = new Observer(agentDir, parentSessionId);
  const context = () => session.extensionRunner?.createContext() || { sessionManager: session.sessionManager, model: session.model };
  await observer.start(context());
  const unsubscribe = session.subscribe(event => observer.event(event, context()));
  return async () => { unsubscribe(); await observer.stop(); };
}
