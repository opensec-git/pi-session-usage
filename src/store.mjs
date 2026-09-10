import { appendFile, mkdir, open, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { Ledger, hash } from "./core.mjs";

export async function sessionHeader(path) {
  if (!path) return undefined;
  let file;
  try {
    file = await open(path, "r");
    const buffer = Buffer.alloc(16 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const value = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]);
    return value.type === "session" && typeof value.id === "string" ? value : undefined;
  } catch { return undefined; }
  finally { await file?.close(); }
}

export class Store {
  ledger = new Ledger();
  offsets = new Map();
  queue = Promise.resolve();
  constructor(directory) {
    this.directory = directory;
    this.file = join(directory, `${process.pid}-${randomUUID()}.jsonl`);
  }
  write(event) {
    this.ledger.apply(event);
    this.queue = this.queue.then(async () => {
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await appendFile(this.file, JSON.stringify(event) + "\n", { mode: 0o600 });
    }).catch(() => { this.ledger.errors.add("Metrics persistence failed; session totals may not survive restart"); });
    return this.queue;
  }
  async refresh() {
    await this.queue;
    let files;
    try { files = await readdir(this.directory); } catch (error) {
      if (error.code !== "ENOENT") this.ledger.errors.add("Cannot read shared metrics directory");
      return;
    }
    for (const name of files.filter(name => /^\d+-[a-f0-9-]+\.jsonl$/.test(name))) {
      const path = join(this.directory, name);
      let file;
      try {
        file = await open(path, "r");
        const stat = await file.stat();
        let offset = this.offsets.get(name) || 0;
        if (stat.size < offset) { offset = 0; this.ledger.errors.add("A metrics journal was truncated; totals may be incomplete"); }
        const buffer = Buffer.alloc(64 * 1024);
        let tail = "", committed = offset;
        const decoder = new StringDecoder("utf8");
        while (offset < stat.size) {
          const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
          if (!bytesRead) break;
          const body = tail + decoder.write(buffer.subarray(0, bytesRead));
          const end = body.lastIndexOf("\n");
          offset += bytesRead;
          if (end < 0) { tail = body; continue; }
          for (const line of body.slice(0, end).split("\n")) {
            if (!line) continue;
            try { this.ledger.apply(JSON.parse(line)); }
            catch { this.ledger.errors.add("Malformed metrics record skipped"); }
          }
          tail = body.slice(end + 1);
          committed = offset - Buffer.byteLength(tail) - (decoder.lastNeed ? decoder.lastTotal - decoder.lastNeed : 0);
        }
        this.offsets.set(name, committed);
      } catch { this.ledger.errors.add("A metrics journal could not be read"); }
      finally { await file?.close(); }
    }
  }
}

// Shared per agent directory in-process; separate processes exchange numeric journals.
const KEY = Symbol.for("opensec.pi-session-usage.v1");
export function sharedStore(directory) {
  const stores = globalThis[KEY] ||= new Map();
  const key = resolve(directory);
  if (!stores.has(key)) stores.set(key, new Store(key));
  return stores.get(key);
}
export async function loadOverrides(agentDir) {
  try {
    const value = JSON.parse(await readFile(join(agentDir, "session-usage-prices.json"), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a price map");
    return value;
  } catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
