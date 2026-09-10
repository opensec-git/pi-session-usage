// Test-only: the parent model invokes the real Tintinweb Agent tool.
import { sharedStore } from "../src/store.mjs";
import { join } from "node:path";
export default function fixture(pi: any) {
  let finished: (() => void) | undefined;
  let rootContext: any;
  pi.on("agent_end", () => { finished?.(); });
  pi.registerCommand("tintin-usage-fixture", { description: "Local Tintinweb integration fixture", handler: async (_args: string, ctx: any) => {
    rootContext = ctx;
    const completion = new Promise<void>(resolve => { finished = resolve; });
    pi.sendUserMessage("usage-fixture-parent");
    await completion;
    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    if (!manager) throw new Error("Real Tintinweb manager was not loaded");
    await manager.waitForAll();
    // Tintinweb debounces background completion notifications; allow those turns to run.
    await new Promise(resolve => setTimeout(resolve, 500));
    await ctx.waitForIdle();
  } });
  // Snapshot only at shutdown, after the meter drains imports and the parent finishes
  // all notification-triggered turns. Counting HTTP starts earlier races completion.
  pi.on("session_shutdown", async () => {
    // @ts-ignore host-provided SDK
    const sdk = await import("@earendil-works/pi-coding-agent");
    const store = sharedStore(join(sdk.getAgentDir(), "session-usage", "v1"));
    await store.refresh();
    const { records, ...summary } = store.ledger.summarize(rootContext.sessionManager.getSessionId());
    console.log(JSON.stringify({ tintinFixture: summary, children: [...store.ledger.children.values()] }));
  });
}
