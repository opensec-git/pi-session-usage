import { Observer } from "./src/observer.mjs";

export default function sessionUsage(pi: any) {
  let observer: any;
  let bound = false;
  // Factory registration is side-effect free; filtered-out child extensions do not collect.
  pi.on("session_start", async (_event: any, ctx: any) => {
    if (observer) await observer.stop();
    // @ts-ignore SDK supplied by the Pi host
    const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
    observer = new Observer(getAgentDir(), process.env.PI_USAGE_PARENT_SESSION_ID);
    await observer.start(ctx);
    bound = true;
    // pi-subagents emits top-level lifecycle events. Child extensions observe their
    // own requests; only the parent consumes the aggregate fallback.
    const header = ctx.sessionManager.getHeader?.();
    const childContext = header?.parentSession || /#[a-zA-Z0-9_-]{8,}$/.test(ctx.sessionManager.getSessionName?.() || "");
    if (!childContext) {
      for (const [event, status] of [["subagents:started", "running"], ["subagents:completed", "complete"], ["subagents:failed", "failed"]]) {
        observer.off.push(pi.events.on(event, (data: any) => observer?.child(data, status)));
      }
    }
    observer.off.push(pi.events.on("session-usage:link", (data: any) => {
      if (data?.parentSessionId === observer?.id) void observer.link(data.sessionId, data.parentSessionId, data.agentId);
    }));
  });
  for (const type of ["before_provider_request", "message_start", "message_update", "message_end", "tool_execution_start", "tool_execution_end", "session_compact", "session_tree"]) {
    pi.on(type, (event: any, ctx: any) => { if (bound) observer.event(event, ctx); });
  }
  pi.on("session_shutdown", async () => { bound = false; await observer?.stop(); observer = undefined; });
  pi.registerCommand("usage-stats", {
    description: "Cumulative cost, cache hits and TPS: /usage-stats [tree|parent|children|all]",
    handler: async (args: string, ctx: any) => {
      const mode = args.trim() || "tree";
      if (!["tree", "parent", "children", "all"].includes(mode)) return ctx.ui.notify("Use tree, parent, children, or all", "error");
      ctx.ui.notify(await observer.show(mode), "info");
    },
  });
}
