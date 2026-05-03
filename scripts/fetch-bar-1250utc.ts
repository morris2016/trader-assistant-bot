// Fetch the 5m bar at 12:50 UTC (= 15:50 EAT) for RDBEAR + RDBULL.
const APP_ID = "1089"; const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function main() {
  const c = new C(); await c.ready;
  const targetEpoch = 1777812600; // 2026-05-03 12:50:00 UTC = 15:50 EAT
  const [bear, bull] = await Promise.all([
    c.send({ ticks_history: "RDBEAR", adjust_start_time: 1, count: 5, end: "latest", style: "candles", granularity: 300 }),
    c.send({ ticks_history: "RDBULL", adjust_start_time: 1, count: 5, end: "latest", style: "candles", granularity: 300 }),
  ]);
  c.close();
  for (const [name, r] of [["RDBEAR", bear], ["RDBULL", bull]] as const) {
    const cs = (r.candles ?? []) as any[];
    console.log(`\n${name} — last 5 bars:`);
    console.log(`  epoch       UTC start    EAT start    open         high         low          close`);
    for (const k of cs) {
      const utc = new Date(k.epoch * 1000).toISOString().slice(11, 19);
      const eat = new Date((k.epoch + 3*3600) * 1000).toISOString().slice(11, 19);
      const flag = k.epoch === targetEpoch ? " ← 15:50 EAT bar" : "";
      console.log(`  ${k.epoch}  ${utc}     ${eat}     ${(+k.open).toFixed(4)}     ${(+k.high).toFixed(4)}     ${(+k.low).toFixed(4)}     ${(+k.close).toFixed(4)}${flag}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
