// Last 1-hour DIGITODD simulation with $20 acct / $5 base / 2.0× mart.
// (NOTE: 100× multiplier doesn't apply to DIGITODD — it's a binary contract.
// Payout is FIXED at 1.95× on win, lose stake on loss. We use the same
// $20/$5/2.0× risk envelope as the multiplier book for parity.)
//
// At $20 acct + $5 base + 2.0× mart:
//   L0 $5    cum $5    fits
//   L1 $10   cum $15   fits  → recovers L0 fully on win
//   L2 $20   cum $35   BUSTS — need $35 but only have $20
// → max safe ladder depth = 1 (single martingale step).
//
// Settlement: every tick = one DIGITODD bet. Predict ODD (the validated
// edge). On win: +stake×0.95. On loss: -stake. Advance ladder up to depth
// MAX_LADDER, reset on win.
//
// Usage: npx ts-node scripts/digitodd-1hr-mart.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOLS = ["R_50", "RDBEAR", "RDBULL", "R_75", "JD75", "1HZ50V", "1HZ100V"];

const ACCT_INIT = 20, BASE_STAKE = 1, MART_RATIO = 2.0;
const PAYOUT = 1.95;       // R_50/RDBEAR/RDBULL/etc — actual Deriv DIGITODD payout
const PAYOUT_R100 = 1.92;  // R_100 has slightly lower payout
const ONE_HOUR = 3600;     // seconds

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(WS_URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

function lastDigit(price: number): number {
  const s = price.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const dec = s.slice(dot + 1);
  if (dec.length === 0) return 0;
  return Number(dec[dec.length - 1]);
}

async function fetchTicks(c: C, sym: string, count: number): Promise<{ epoch: number[]; quote: number[] }> {
  const PAGE = 5000; let end: any = "latest"; const epoch: number[] = [], quote: number[] = []; let remaining = count;
  while (remaining > 0) {
    const ask = Math.min(PAGE, remaining);
    let r: any;
    try { r = await c.send({ ticks_history: sym, count: ask, end: String(end), style: "ticks", adjust_start_time: 1 }); }
    catch { break; }
    const h = r.history;
    if (!h || !h.times || h.times.length === 0) break;
    epoch.unshift(...h.times);
    quote.unshift(...(h.prices as number[]));
    if (h.times.length < ask) break;
    end = h.times[0] - 1;
    remaining -= h.times.length;
  }
  return { epoch, quote };
}

function round2(x: number) { return Math.round(x * 100) / 100; }

type Result = { sym: string; ticks1h: number; bets: number; wins: number; losses: number; net: number; finalBal: number; peak: number; trough: number; maxDD: number; bust: number; maxLadder: number; longestL: number };

function sim(quotes: number[], payout: number, sym: string): Result {
  let bal = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, maxDD = 0;
  let bets = 0, wins = 0, losses = 0, net = 0, bust = 0, maxLadderHit = 0, curStreak = 0, longestL = 0;
  let level = 0;

  for (const q of quotes) {
    // Compute affordable stake at current level. If bal can't cover, reset
    // ladder to L0 and try again. If even L0 unaffordable → bust.
    let stake = BASE_STAKE * Math.pow(MART_RATIO, level);
    if (bal < stake) {
      // Can't afford ladder bet — drop to L0 if possible, else bust
      level = 0;
      stake = BASE_STAKE;
      if (bal < stake) { bust++; bal = ACCT_INIT; peak = ACCT_INIT; trough = ACCT_INIT; }
    }
    if (level > maxLadderHit) maxLadderHit = level;
    const isOdd = lastDigit(q) % 2 !== 0;
    bets++;
    if (isOdd) {
      // WIN: +stake × (payout - 1) profit (payout includes returned stake)
      const profit = round2(stake * (payout - 1));
      bal = round2(bal + profit);
      net += profit;
      wins++;
      level = 0;
      curStreak = 0;
    } else {
      // LOSS: -stake
      bal = round2(bal - stake);
      net -= stake;
      losses++;
      curStreak++;
      if (curStreak > longestL) longestL = curStreak;
      level += 1;
      // No max ladder cap — but if next stake exceeds balance, the next
      // iteration's affordability check will reset to L0.
    }
    if (bal > peak) peak = bal;
    if (bal < trough) trough = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
  }
  return { sym, ticks1h: quotes.length, bets, wins, losses, net: round2(net), finalBal: bal, peak: round2(peak), trough: round2(trough), maxDD: round2(maxDD), bust, maxLadder: maxLadderHit, longestL };
}

async function main() {
  const c = new C(); await c.ready;
  console.log(`DIGITODD 1-hour SIM — $${ACCT_INIT} acct · $${BASE_STAKE} base · ${MART_RATIO}× mart`);
  console.log(`Each tick = one DIGITODD bet (predict ODD). Win=+stake×0.95, Lose=-stake.`);
  console.log(`Ladder cum-loss at $${BASE_STAKE} base × ${MART_RATIO}×:`);
  for (let L = 0; L <= 5; L++) {
    const stake = BASE_STAKE * Math.pow(MART_RATIO, L);
    const cum = Array.from({ length: L + 1 }, (_, i) => BASE_STAKE * Math.pow(MART_RATIO, i)).reduce((a, b) => a + b, 0);
    const fits = cum <= ACCT_INIT;
    console.log(`  L${L}: $${stake.toFixed(2)}  cum if all lose: $${cum.toFixed(2)}  ${fits ? "fits" : "✗ BUSTS"}`);
  }
  console.log();

  const results: Result[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} fetching last hour... `);
    // Pull 4000 ticks then filter to last 3600 seconds
    const all = await fetchTicks(c, sym, 4000);
    if (all.epoch.length === 0) { console.log(`no data`); continue; }
    const latest = all.epoch[all.epoch.length - 1];
    const fromEpoch = latest - ONE_HOUR;
    const idx = all.epoch.findIndex((e) => e >= fromEpoch);
    const quotes = idx < 0 ? [] : all.quote.slice(idx);
    if (quotes.length === 0) { console.log(`no ticks in last hr`); continue; }
    const fromTime = new Date((latest - ONE_HOUR) * 1000).toISOString().slice(11, 19);
    const toTime = new Date(latest * 1000).toISOString().slice(11, 19);
    console.log(`${quotes.length} ticks  ${fromTime} → ${toTime} UTC`);

    const payout = sym === "R_100" ? PAYOUT_R100 : PAYOUT;
    const r = sim(quotes, payout, sym);
    results.push(r);
  }
  c.close();

  console.log(`\n${"".padEnd(115, "═")}`);
  console.log(`RESULTS — last 1 hour, sorted by net`);
  console.log(`${"".padEnd(115, "═")}`);
  results.sort((a, b) => b.net - a.net);
  console.log(`${"sym".padEnd(10)} ${"ticks".padStart(6)}  ${"bets".padStart(5)}  ${"W".padStart(4)}/${"L".padStart(4)}  WR     net          finalBal   peak     maxDD   maxLadder  longestL  bust`);
  for (const r of results) {
    const wr = r.bets > 0 ? r.wins / r.bets : 0;
    console.log(`${r.sym.padEnd(10)} ${r.ticks1h.toString().padStart(6)}  ${r.bets.toString().padStart(5)}  ${r.wins.toString().padStart(4)}/${r.losses.toString().padStart(4)}  ${(wr*100).toFixed(1).padStart(5)}%  ${r.net >= 0 ? "+" : ""}$${r.net.toFixed(2).padStart(8)}  $${r.finalBal.toFixed(2).padStart(7)}  $${r.peak.toFixed(2).padStart(7)}  $${r.maxDD.toFixed(2).padStart(6)}  L${r.maxLadder.toString().padStart(2)}        ${r.longestL.toString().padStart(2)}        ${r.bust}`);
  }

  const totalNet = results.reduce((a, b) => a + b.net, 0);
  const totalBets = results.reduce((a, b) => a + b.bets, 0);
  const totalBust = results.reduce((a, b) => a + b.bust, 0);
  console.log(`\nCombined book (parallel on ${results.length} symbols, each $${ACCT_INIT} acct):`);
  console.log(`  bets=${totalBets}  net=${totalNet >= 0 ? "+" : ""}$${totalNet.toFixed(2)}  busts=${totalBust}`);
  console.log(`  per-symbol avg: ${totalNet >= 0 ? "+" : ""}$${(totalNet / results.length).toFixed(2)} on $${ACCT_INIT} acct in 1h`);
  console.log(`  hourly ROI: ${(totalNet / (results.length * ACCT_INIT) * 100).toFixed(1)}%`);
}
main().catch((e) => { console.error(e); process.exit(1); });
