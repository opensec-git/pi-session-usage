import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, appendFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/store.mjs";
import { makeRecord } from "../src/core.mjs";
test("cross-process-style journals, restart replay, duplicate receipts and partial append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-store-"));
  const first = new Store(dir), second = new Store(dir);
  await first.write({ type: "session", id: "p" });
  await second.write({ type: "session", id: "c", parentId: "p" });
  const record = makeRecord({ role: "assistant", provider: "test", model: "test", responseId: "id", timestamp: 1000,
    content: [{ text: "SECRET THAT MUST NOT BE STORED" }], usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 10, cost: { total: 0.1 } }, stopReason: "stop" }, "c", { firstTokenAt: 1000, endedAt: 2000 });
  await second.write(record); await second.write(record);
  await first.refresh();
  assert.equal(first.ledger.summarize("p").requests, 1);
  assert.equal(first.ledger.summarize("p").costUsd, 0.1);
  assert.doesNotMatch(await readFile(second.file, "utf8"), /SECRET/);
  await appendFile(first.file, '{"type":"session","id":"later"');
  await first.refresh(); assert.equal(first.ledger.sessions.has("later"), false);
  await appendFile(first.file, ',"parentId":"p"}\n');
  await first.refresh(); assert.equal(first.ledger.sessions.has("later"), true);
  const restart = new Store(dir); await restart.refresh();
  assert.equal(restart.ledger.summarize("p").requests, 1);
  assert.equal(restart.ledger.summarize("p").tps, 10);
});
