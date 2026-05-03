// Discover Deriv synth/RNG symbols available via the API
const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function main() {
  const c = new C(); await c.ready;
  const r = await c.send({ active_symbols: "brief", product_type: "basic" });
  c.close();
  const symbols = r.active_symbols ?? [];
  // Filter to non-forex/crypto/commodity (synthetic indices typically)
  const synths = symbols.filter((s: any) =>
    s.market === "synthetic_index" || s.submarket?.includes("random") || s.submarket?.includes("crash") || s.submarket?.includes("step") || s.submarket?.includes("drift") || s.submarket?.includes("daily")
  );
  console.log(`Found ${synths.length} synthetic index symbols\n`);
  // Group by submarket
  const groups: Record<string, any[]> = {};
  for (const s of synths) {
    const k = s.submarket_display_name ?? s.submarket ?? "unknown";
    if (!groups[k]) groups[k] = [];
    groups[k].push(s);
  }
  for (const [k, arr] of Object.entries(groups).sort()) {
    console.log(`\n=== ${k} (${arr.length}) ===`);
    for (const s of arr) {
      console.log(`  ${s.symbol.padEnd(20)} ${s.display_name}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
