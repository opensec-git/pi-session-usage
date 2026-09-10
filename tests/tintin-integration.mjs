import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

// Override to test a different installed version; never installs or changes user settings.
const tintin = process.env.PI_SUBAGENTS_PACKAGE_DIR || join(homedir(), ".pi/agent/npm/node_modules/@tintinweb/pi-subagents");
const version = JSON.parse(await readFile(join(tintin, "package.json"), "utf8")).version;
const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const fixture = fileURLToPath(new URL("./tintin-fixture.ts", import.meta.url));
for (const background of [false, true]) for (const mode of ["instrumented-persisted", "instrumented-memory", "uninstrumented-persisted", "uninstrumented-memory"]) {
  const instrumented = mode.startsWith("instrumented-");
  const persisted = mode.endsWith("persisted");
  const root = await mkdtemp(join(tmpdir(), "pi-tintin-usage-"));
  const agentDir = join(root, "agent");
  await mkdir(join(agentDir, "agents"), { recursive: true });
  await writeFile(join(agentDir, "agents/usage-worker.md"), `---\nname: usage-worker\ndescription: Deterministic local telemetry fixture\ntools: none\nextensions: ${instrumented ? JSON.stringify([extension]) : "false"}\nskills: false\npersist_session: ${persisted}\n---\nReply with fixture ok.\n`);
  await writeFile(join(agentDir, "subagents.json"), JSON.stringify({ reportUsage: true }));
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let text = ""; for await (const part of req) text += part;
    const body = JSON.parse(text);
    const userText = JSON.stringify(body.messages.filter(m => m.role === "user"));
    const which = userText.includes("usage-fixture-child-one") ? 1 : userText.includes("usage-fixture-child-two") ? 2 : 0;
    const launch = which === 0 && !body.messages.some(m => m.role === "tool");
    calls.push({ which, launch });
    const id = `tintin-fixture-${calls.length}`;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const chunk = (delta, finish_reason = null, usage) => res.write("data: " + JSON.stringify({
      id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
    }) + "\n\n");
    chunk({ role: "assistant", content: "fixture " });
    await new Promise(resolve => setTimeout(resolve, 30));
    if (launch) {
      assert.ok(body.tools.some(t => t.function.name === "Agent"), "Real Agent tool must be exposed to parent");
      chunk({ tool_calls: ["one", "two"].map((label, index) => ({ index, id: `tool-${label}`, type: "function", function: {
        name: "Agent", arguments: JSON.stringify({ prompt: `usage-fixture-child-${label}`, description: `Telemetry child ${label}`, subagent_type: "usage-worker", ...(background ? {} : { run_in_background: false }) }),
      } })) });
    } else chunk({ content: "ok" });
    await new Promise(resolve => setTimeout(resolve, 30));
    const hits = [900, 100, 1000][which], output = [10, 20, 30][which];
    chunk({}, launch ? "tool_calls" : "stop", { prompt_tokens: 1000, prompt_cache_hit_tokens: hits,
      prompt_cache_miss_tokens: 1000 - hits, completion_tokens: output, total_tokens: 1000 + output });
    res.end("data: [DONE]\n\n");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "fixture-deepseek": {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only-not-a-real-key",
    models: [{ id: "deepseek-fixture", name: "Local telemetry fixture", reasoning: false, input: ["text"],
      contextWindow: 32768, maxTokens: 256, cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } }],
  } } }));
  const child = spawn("pi", ["--approve", "--offline", "--no-extensions", "--extension", extension,
    "--extension", join(tintin, "src/index.ts"), "--extension", fixture, "--no-skills", "--no-context-files",
    "--model", "fixture-deepseek/deepseek-fixture", "--thinking", "off", "--mode", "json", "--print", "/tintin-usage-fixture"],
  { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
  const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
  try {
    const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
    assert.equal(code, 0, mode + "\n" + stderr + stdout.slice(-6000));
    const result = (stdout + "\n" + stderr).split("\n").flatMap(line => { try { const parsed = JSON.parse(line); return parsed.tintinFixture ? [parsed] : []; } catch { return []; } }).at(-1);
    assert.ok(result, mode + "\n" + stderr + stdout.slice(-6000));
    const summary = result.tintinFixture;
    assert.equal(calls.filter(c => c.which === 1).length, 1, JSON.stringify({ mode, background, calls, result }));
    assert.equal(calls.filter(c => c.which === 2).length, 1);
    const parentCalls = calls.filter(c => c.which === 0).length;
    assert.ok(parentCalls >= 2);
    if (!background) assert.equal(parentCalls, 2);
    assert.equal(result.children.length, 2);
    assert.equal(summary.promptTokens, calls.length * 1000, JSON.stringify({ mode, background, result }));
    assert.equal(summary.cacheRead, parentCalls * 900 + 1100);
    assert.equal(summary.cacheHitRate, (parentCalls * 900 + 1100) / (calls.length * 1000));
    assert.equal(summary.output, parentCalls * 10 + 50);
    assert.ok(Math.abs(summary.costUsd - (parentCalls * 0.0000474 + 0.0003366)) < 1e-10, JSON.stringify({ mode, result }));
    assert.equal(summary.unknownChildren, 0);
    assert.equal(summary.unknownUsage, 0);
    assert.equal(summary.unpriced, 0);
    assert.deepEqual(summary.warnings, []);
    assert.equal(summary.timedRequests, instrumented ? calls.length : parentCalls);
    assert.equal(summary.summaryChildren, !instrumented && !persisted ? 2 : 0);
    console.log(JSON.stringify({ pass: true, packageVersion: version, background, mode, ...summary }, null, 2));
  } finally { clearTimeout(timer); server.closeAllConnections(); server.close(); }
}
