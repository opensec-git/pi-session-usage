import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
const root = await mkdtemp(join(tmpdir(), "pi-usage-fixture-"));
const agentDir = join(root, "agent"); await mkdir(agentDir);
let requests = 0;
const server = http.createServer(async (req, res) => {
  let text = ""; for await (const part of req) text += part;
  const body = JSON.parse(text);
  const prompt = JSON.stringify(body.messages.at(-1));
  const which = prompt.includes("child-one") ? 1 : prompt.includes("child-two") ? 2 : 0;
  const hits = [900, 100, 1000][which], outputs = [10, 20, 30][which];
  const id = `fixture-${++requests}`;
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  const chunk = (delta, finish_reason = null, usage) => res.write("data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model,
    choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
  }) + "\n\n");
  chunk({ role: "assistant", content: "fixture " });
  await new Promise(resolve => setTimeout(resolve, 30));
  chunk({ content: "ok" });
  await new Promise(resolve => setTimeout(resolve, 30));
  chunk({}, "stop", { prompt_tokens: 1000, prompt_cache_hit_tokens: hits, prompt_cache_miss_tokens: 1000 - hits,
    completion_tokens: outputs, total_tokens: 1000 + outputs, completion_tokens_details: { reasoning_tokens: 2 } });
  res.end("data: [DONE]\n\n");
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
await writeFile(join(agentDir, "models.json"), JSON.stringify({ providers: { "fixture-deepseek": {
  baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: "openai-completions", apiKey: "fixture-only-not-a-real-key",
  models: [{ id: "deepseek-fixture", name: "DeepSeek usage fixture", reasoning: false, input: ["text"],
    contextWindow: 32768, maxTokens: 128, cost: { input: 0.3, output: 1.2, cacheRead: 0.006, cacheWrite: 0 } }],
} } }));
const child = spawn("pi", ["--approve", "--offline", "--no-extensions", "--extension", fileURLToPath(new URL("../index.ts", import.meta.url)),
  "--extension", fileURLToPath(new URL("./pi-fixture.ts", import.meta.url)), "--no-skills", "--no-context-files",
  "--model", "fixture-deepseek/deepseek-fixture", "--thinking", "off", "--mode", "json", "--print", "/usage-fixture"],
  { cwd: root, env: { ...process.env, PI_CODING_AGENT_DIR: agentDir }, stdio: ["ignore", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", data => { stdout += data; }); child.stderr.on("data", data => { stderr += data; });
const timer = setTimeout(() => child.kill("SIGTERM"), 60000);
try {
  const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  assert.equal(code, 0, stderr + stdout.slice(-3000));
  const summary = (stdout + "\n" + stderr).split("\n").flatMap(line => { try { const parsed = JSON.parse(line); return parsed.usageFixture ? [parsed.usageFixture] : []; } catch { return []; } }).at(-1);
  assert.ok(summary, stderr + stdout.slice(-4000));
  assert.equal(requests, 3);
  assert.equal(summary.requests, 3); assert.equal(summary.sessions, 3);
  assert.equal(summary.promptTokens, 3000); assert.equal(summary.cacheRead, 2000);
  assert.equal(summary.cacheHitRate, 2 / 3); assert.equal(summary.output, 60);
  assert.ok(Math.abs(summary.costUsd - 0.000384) < 1e-10);
  assert.equal(summary.timedRequests, 3); assert.ok(summary.tps > 0);
  console.log(JSON.stringify({ pass: true, fixture: "Real Pi CLI + two parallel SDK children + local DeepSeek-format SSE API", ...summary }, null, 2));
} finally { clearTimeout(timer); server.closeAllConnections(); server.close(); }
