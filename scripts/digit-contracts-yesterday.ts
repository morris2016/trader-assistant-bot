// Yesterday's expected P&L sweep across ALL DIGIT contract types on all
// fast3 symbols. Pulls 24h of ticks (yesterday UTC), queries Deriv for
// actual proposal payouts on every contract+barrier combo, computes EV/tick
// and total expected $ at $1 stake.
//
// Contracts tested per symbol:
//   DIGITODD, DIGITEVEN
//   DIGITOVER  with barrier 0..8 (9 contracts)
//   DIGITUNDER with barrier 1..9 (9 contracts)
//   DIGITMATCH with barrier 0..9 (10 contracts)
//   DIGITDIFF  with barrier 0..9 (10 contracts)
//
// = 40 contract variants × 8 symbols = 320 combos.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/digit-contracts-yesterday.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V", "JD75"];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(WS_URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try {
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
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
  close() { try { this.ws.close(); } catch {} }
}

function lastDigit(price: number): number {
  const s = price.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const dec = s.slice(dot + 1);
  if (dec.length === 0) return 0;
  return Number(dec[dec.length - 1]);
}

async function fetchYesterdayTicks(c: C, sym: string): Promise<number[]> {
  // Yesterday UTC: midnight to midnight. Use end="latest" then trim to last 24h
  // (Deriv's `start`/`end` params can be flaky with auth; pulling latest is reliable).
  const PAGE = 5000;
  let end: any = "latest";
  const epochs: number[] = [];
  const quotes: number[] = [];
  let attempts = 0;
  // Pull ~24h worth — varies per symbol (R_* ~0.5Hz=43200/24h; 1HZ*=86400/24h; JD75~1Hz)
  const target = 90_000;
  while (quotes.length < target && attempts < 25) {
    attempts++;
    let r: any;
    try { r = await c.send({ ticks_history: sym, count: PAGE, end: String(end), style: "ticks", adjust_start_time: 1 }); }
    catch { break; }
    const h = r.history;
    if (!h || !h.times || h.times.length === 0) break;
    epochs.unshift(...(h.times as number[]));
    quotes.unshift(...(h.prices as number[]));
    if (h.times.length < PAGE) break;
    end = h.times[0] - 1;
  }
  // Filter to last 24h
  if (epochs.length === 0) return [];
  const cutoff = epochs[epochs.length - 1] - 24 * 3600;
  const idx = epochs.findIndex((e) => e >= cutoff);
  return idx < 0 ? [] : quotes.slice(idx);
}

async function getProposal(c: C, sym: string, contract_type: string, barrier?: number): Promise<number | null> {
  const req: any = {
    proposal: 1,
    amount: 1,
    basis: "stake",
    contract_type,
    currency: "USD",
    duration: 1,
    duration_unit: "t",
    symbol: sym,
  };
  if (barrier != null) req.barrier = String(barrier);
  try {
    const r = await c.send(req);
    return r.proposal?.payout ?? null;
  } catch {
    return null;
  }
}

type Row = {
  sym: string; contract: string; barrier: number | null;
  payout: number; pWin: number; evPer$1: number;
  ticks: number; expectedNetPerTick: number; expectedDailyNet: number;
};

async function main() {
  const c = new C(); await c.ready;
  await c.send({ authorize: TOKEN });
  console.log(`Yesterday's DIGIT-contract sweep — 24h ticks × 40 contract variants × 8 symbols\n`);

  const allRows: Row[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym}: pulling 24h ticks... `);
    const Q = await fetchYesterdayTicks(c, sym);
    if (Q.length < 1000) { console.log(`only ${Q.length} ticks — skip`); continue; }
    console.log(`${Q.length} ticks`);

    // Empirical digit distribution
    const digitCount = new Array(10).fill(0);
    for (const q of Q) digitCount[lastDigit(q)]++;
    const N = Q.length;
    const P = digitCount.map((c) => c / N);

    // Build win-probability matrix per contract type/barrier
    const tests: { contract: string; barrier?: number; pWin: number }[] = [
      { contract: "DIGITODD",  pWin: P[1]+P[3]+P[5]+P[7]+P[9] },
      { contract: "DIGITEVEN", pWin: P[0]+P[2]+P[4]+P[6]+P[8] },
    ];
    for (let b = 0; b <= 8; b++) {
      let p = 0; for (let d = b+1; d <= 9; d++) p += P[d];
      tests.push({ contract: "DIGITOVER", barrier: b, pWin: p });
    }
    for (let b = 1; b <= 9; b++) {
      let p = 0; for (let d = 0; d < b; d++) p += P[d];
      tests.push({ contract: "DIGITUNDER", barrier: b, pWin: p });
    }
    for (let d = 0; d <= 9; d++) tests.push({ contract: "DIGITMATCH", barrier: d, pWin: P[d] });
    for (let d = 0; d <= 9; d++) tests.push({ contract: "DIGITDIFF",  barrier: d, pWin: 1 - P[d] });

    // Fetch payouts in parallel batches (rate-limit safe — 5 at a time)
    const BATCH = 5;
    for (let i = 0; i < tests.length; i += BATCH) {
      const slice = tests.slice(i, i + BATCH);
      const results = await Promise.all(slice.map(async (t) => {
        const payout = await getProposal(c, sym, t.contract, t.barrier);
        return { ...t, payout };
      }));
      for (const r of results) {
        if (r.payout == null) continue;
        const evPer$1 = r.pWin * (r.payout - 1) - (1 - r.pWin);
        const expectedNetPerTick = evPer$1; // $1 stake per tick
        allRows.push({
          sym,
          contract: r.contract,
          barrier: r.barrier ?? null,
          payout: r.payout,
          pWin: r.pWin,
          evPer$1,
          ticks: N,
          expectedNetPerTick,
          expectedDailyNet: evPer$1 * N,
        });
      }
      // tiny pause between batches to stay under proposal rate limit
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  c.close();

  // Sort by expected daily net, descending
  allRows.sort((a, b) => b.expectedDailyNet - a.expectedDailyNet);

  console.log(`\n${"".padEnd(115, "═")}`);
  console.log(`TOP 25 EV-positive combos at $1 stake (sorted by expected $ at 24h volume):`);
  console.log(`${"".padEnd(115, "═")}`);
  console.log(`${"sym".padEnd(10)} ${"contract".padEnd(12)} ${"barrier".padStart(7)} ${"payout".padStart(7)} ${"P(win)".padStart(7)} ${"EV/$1".padStart(9)} ${"ticks".padStart(6)} ${"24h net @ $1".padStart(13)}`);
  for (const r of allRows.slice(0, 25)) {
    console.log(`${r.sym.padEnd(10)} ${r.contract.padEnd(12)} ${(r.barrier == null ? "—" : String(r.barrier)).padStart(7)} ${r.payout.toFixed(3).padStart(7)} ${(r.pWin*100).toFixed(2).padStart(6)}% ${(r.evPer$1 >= 0 ? "+" : "") + r.evPer$1.toFixed(4).padStart(8)} ${String(r.ticks).padStart(6)} ${(r.expectedDailyNet >= 0 ? "+" : "") + "$" + r.expectedDailyNet.toFixed(2).padStart(11)}`);
  }

  // Bottom 10 (negative-EV combos)
  console.log(`\n${"".padEnd(115, "═")}`);
  console.log(`BOTTOM 10 (worst EV — DO NOT TRADE):`);
  console.log(`${"".padEnd(115, "═")}`);
  for (const r of allRows.slice(-10).reverse()) {
    console.log(`${r.sym.padEnd(10)} ${r.contract.padEnd(12)} ${(r.barrier == null ? "—" : String(r.barrier)).padStart(7)} ${r.payout.toFixed(3).padStart(7)} ${(r.pWin*100).toFixed(2).padStart(6)}% ${(r.evPer$1 >= 0 ? "+" : "") + r.evPer$1.toFixed(4).padStart(8)} ${String(r.ticks).padStart(6)} ${(r.expectedDailyNet >= 0 ? "+" : "") + "$" + r.expectedDailyNet.toFixed(2).padStart(11)}`);
  }

  // Per-symbol summary: best variant
  console.log(`\n${"".padEnd(115, "═")}`);
  console.log(`BEST VARIANT PER SYMBOL:`);
  console.log(`${"".padEnd(115, "═")}`);
  const bySymBest = new Map<string, Row>();
  for (const r of allRows) {
    const cur = bySymBest.get(r.sym);
    if (!cur || r.expectedDailyNet > cur.expectedDailyNet) bySymBest.set(r.sym, r);
  }
  for (const [, r] of Array.from(bySymBest.entries())) {
    console.log(`${r.sym.padEnd(10)} → ${r.contract}${r.barrier != null ? `=${r.barrier}` : ""} payout=${r.payout.toFixed(3)} WR=${(r.pWin*100).toFixed(2)}% EV/$1=${r.evPer$1 >= 0 ? "+" : ""}${r.evPer$1.toFixed(4)} 24h@$1=${r.expectedDailyNet >= 0 ? "+" : ""}$${r.expectedDailyNet.toFixed(2)}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
