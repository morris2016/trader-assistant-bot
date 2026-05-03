// List Deriv synths grouped by submarket so we can pick "math-y" candidates
// (Step indices, Range Break, Jump Diffusion) rather than pure random walks.

import WebSocket from "ws";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try {
        const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch { /* */ }
    });
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000);
    });
  }
  close() { this.ws.close(); }
}

async function main() {
  const c = new C(); await c.ready;
  const r = await c.send({ active_symbols: "brief" });
  c.close();
  const synths = ((r.active_symbols ?? []) as any[]).filter((s) => String(s.market || "").toLowerCase().includes("synthetic"));
  const bySubmarket = new Map<string, any[]>();
  for (const s of synths) {
    const sm = String(s.submarket);
    if (!bySubmarket.has(sm)) bySubmarket.set(sm, []);
    bySubmarket.get(sm)!.push(s);
  }
  for (const [sm, list] of bySubmarket) {
    if (sm === "random_index" || sm === "forex_basket" || sm === "commodity_basket") continue; // skip random walks + baskets
    console.log(`\n──── ${sm} (${list.length}) ────`);
    for (const s of list) console.log(`  ${String(s.symbol).padEnd(15)} ${s.display_name}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
