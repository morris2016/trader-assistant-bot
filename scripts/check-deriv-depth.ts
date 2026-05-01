// Quick probe: how far back does Deriv's ticks_history go for our 3 symbols
// at 1m and 5m granularities? We need data for March 15 = ~46 days back from today.
// If Deriv only stores ~17d of 1m, we'll need to either skip 1m strategies or
// use 5m only.

import WebSocket from "ws";

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

class C {
  ws!: WebSocket; reqId = 1;
  pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    this.ws = new WebSocket(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {}
    });
    this.ws.on("error", () => {});
  }
  send(p: any): Promise<any> { const id = this.reqId++;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...p, req_id: id }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error("timeout")); }, 30_000); }); }
}

async function probe(c: C, sym: string, gr: number, targetEpoch: number) {
  // Try fetching 5000 bars ending at targetEpoch
  try {
    const r = await c.send({
      ticks_history: sym, adjust_start_time: 1, count: 5000, end: String(targetEpoch),
      style: "candles", granularity: gr,
    });
    const candles = r.candles ?? [];
    if (candles.length > 0) {
      const first = new Date(candles[0].epoch * 1000).toISOString();
      const last = new Date(candles[candles.length - 1].epoch * 1000).toISOString();
      console.log(`${sym}@${gr}s end=${new Date(targetEpoch * 1000).toISOString().slice(0,10)}: got ${candles.length} bars (${first} → ${last})`);
    } else {
      console.log(`${sym}@${gr}s end=${new Date(targetEpoch * 1000).toISOString().slice(0,10)}: NO DATA`);
    }
  } catch (e) {
    console.log(`${sym}@${gr}s end=${new Date(targetEpoch * 1000).toISOString().slice(0,10)}: ERROR ${(e as Error).message}`);
  }
}

async function main() {
  const c = new C(); await c.ready;
  const MAR_22 = 1774224000;
  const MAR_15 = 1773532800;
  for (const sym of ["BOOM300N", "CRASH300N"]) {
    for (const gr of [60, 300]) {
      await probe(c, sym, gr, MAR_22);
    }
  }
  c.ws.close();
}
main().catch(console.error);
