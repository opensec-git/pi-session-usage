// Only loaded by the local, fake-API integration test. No real provider requests.
import { attachSession } from "../src/observer.mjs";
import { sharedStore } from "../src/store.mjs";
import { join } from "node:path";
export default function fixture(pi: any) {
  pi.registerCommand("usage-fixture", { description: "Local integration fixture", handler: async (_args: string, ctx: any) => {
    pi.sendUserMessage("parent");
    await ctx.waitForIdle();
    // @ts-ignore host-provided SDK
    const sdk = await import("@earendil-works/pi-coding-agent");
    const agentDir = sdk.getAgentDir();
    const parentSessionId = ctx.sessionManager.getSessionId();
    await Promise.all(["child-one", "child-two"].map(async label => {
      const runtime = await sdk.ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
      const settingsManager = sdk.SettingsManager.inMemory();
      const loader = new sdk.DefaultResourceLoader({ cwd: ctx.cwd, agentDir, settingsManager, noExtensions: true,
        noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true, systemPrompt: "Local usage fixture." });
      await loader.reload();
      const sessionManager = sdk.SessionManager.create(ctx.cwd, join(agentDir, "children"), { parentSession: ctx.sessionManager.getSessionFile() });
      const { session } = await sdk.createAgentSession({ cwd: ctx.cwd, agentDir, settingsManager, resourceLoader: loader,
        sessionManager, modelRuntime: runtime, model: ctx.model, tools: [] });
      const detach = await attachSession(session, { agentDir, parentSessionId });
      try { await session.prompt(label); } finally { await detach(); session.dispose(); }
    }));
    const store = sharedStore(join(agentDir, "session-usage", "v1"));
    await store.refresh();
    const { records, ...summary } = store.ledger.summarize(parentSessionId);
    console.log(JSON.stringify({ usageFixture: summary }));
  } });
}
