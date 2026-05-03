// Shared-pool DIGITODD 1-hour sim. ONE $41 balance, $1 base, 1.5× mart,
// all symbols trade off the same pool with per-symbol martingale ladders.
//
// Ladder cum-loss at $1 × 1.5×:
//   L0 $1.00  cum  $1.00     fits
//   L1 $1.50  cum  $2.50     fits
//   L2 $2.25  cum  $4.75     fits
//   L3 $3.38  cum  $8.13     fits
//   L4 $5.06  cum $13.19     fits
//   L5 $7.59  cum $20.78     fits
//   L6 $11.39 cum $32.17     fits
//   L7 $17.09 cum $49.25     ✗ BUSTS on $41 acct
// → max safe depth = 6 (single-symbol cumulative loss). With 7 parallel
// symbols, the affordability check is per-bet (does current stake fit in
// remaining balance?) not per-symbol ladder.
//
// Usage: npx ts-node scripts/digitodd-1hr-shared.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOLS = ["R_50", "RDBEAR", "RDBULL", "R_75", "JD75", "1HZ50V", "1HZ100V"];

const ACCT_INIT = 41, BASE_STAKE = 1, MART_RATIO = 1.5;
const PAYOUT = 1.95;
const PAYOUT_R100 = 1.92;
const ONE_HOUR = 3600;

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

async function main() {
  const c = new C(); await c.ready;
  console.log(`DIGITODD shared-pool 1-hour SIM`);
  console.log(`  acct=$${ACCT_INIT}  base=$${BASE_STAKE}  mart=${MART_RATIO}×  payout=${PAYOUT}×`);
  console.log(`  ${SYMBOLS.length} symbols share ONE balance pool with per-symbol ladders\n`);

  // ── Fetch last 1 hour per symbol, build merged event stream ──
  type Tick = { epoch: number; quote: number; sym: string };
  const allTicks: Tick[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} fetching... `);
    const all = await fetchTicks(c, sym, 4000);
    if (all.epoch.length === 0) { console.log(`no data`); continue; }
    const latest = all.epoch[all.epoch.length - 1];
    const fromEpoch = latest - ONE_HOUR;
    const idx = all.epoch.findIndex((e) => e >= fromEpoch);
    if (idx < 0) { console.log(`no ticks in last hr`); continue; }
    const tickCount = all.epoch.length - idx;
    for (let i = idx; i < all.epoch.length; i++) {
      allTicks.push({ epoch: all.epoch[i], quote: all.quote[i], sym });
    }
    console.log(`${tickCount} ticks  ${new Date((latest - ONE_HOUR) * 1000).toISOString().slice(11,19)} → ${new Date(latest * 1000).toISOString().slice(11,19)} UTC`);
  }
  c.close();

  allTicks.sort((a, b) => a.epoch - b.epoch || a.sym.localeCompare(b.sym));
  console.log(`\nMerged stream: ${allTicks.length} ticks across all symbols\n`);

  // ── Simulation: shared balance + per-symbol ladder ──
  type StratStat = { sym: string; bets: number; wins: number; losses: number; net: number; level: number; longestL: number; curStreak: number; maxLadder: number; skipped: number };
  const stats = new Map<string, StratStat>();
  for (const sym of SYMBOLS) stats.set(sym, { sym, bets: 0, wins: 0, losses: 0, net: 0, level: 0, longestL: 0, curStreak: 0, maxLadder: 0, skipped: 0 });

  let bal = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, maxDD = 0;
  let totalBets = 0, totalWins = 0, totalSkips = 0, bust = 0;
  const balOverTime: { epoch: number; bal: number }[] = [{ epoch: allTicks[0].epoch, bal }];

  for (const t of allTicks) {
    const s = stats.get(t.sym)!;
    const stake = round2(BASE_STAKE * Math.pow(MART_RATIO, s.level));

    // Affordability check on shared pool
    if (bal < stake) {
      // Try resetting THIS symbol's ladder to L0 and bet base stake
      s.level = 0;
      const fallback = BASE_STAKE;
      if (bal < fallback) {
        // Truly broke — count bust, redeposit
        bust++;
        bal = ACCT_INIT;
        peak = ACCT_INIT;
        trough = ACCT_INIT;
        // Reset ALL symbol ladders since it's a fresh start
        for (const k of Array.from(stats.keys())) stats.get(k)!.level = 0;
      }
      s.skipped++;
      totalSkips++;
      continue;
    }
    if (s.level > s.maxLadder) s.maxLadder = s.level;

    const isOdd = lastDigit(t.quote) % 2 !== 0;
    const payout = t.sym === "R_100" ? PAYOUT_R100 : PAYOUT;
    s.bets++;
    totalBets++;
    if (isOdd) {
      const profit = round2(stake * (payout - 1));
      bal = round2(bal + profit);
      s.net = round2(s.net + profit);
      s.wins++;
      totalWins++;
      s.level = 0;
      s.curStreak = 0;
    } else {
      bal = round2(bal - stake);
      s.net = round2(s.net - stake);
      s.losses++;
      s.curStreak++;
      if (s.curStreak > s.longestL) s.longestL = s.curStreak;
      s.level += 1;
    }
    if (bal > peak) peak = bal;
    if (bal < trough) trough = bal;
    const dd = peak - bal;
    if (dd > maxDD) maxDD = dd;
    balOverTime.push({ epoch: t.epoch, bal });
  }

  const wr = totalBets > 0 ? totalWins / totalBets * 100 : 0;
  console.log(`${"".padEnd(115, "═")}`);
  console.log(`SHARED POOL RESULT`);
  console.log(`${"".padEnd(115, "═")}`);
  console.log(`  total bets:      ${totalBets}`);
  console.log(`  wins / losses:   ${totalWins} / ${totalBets - totalWins}  (WR ${wr.toFixed(2)}%)`);
  console.log(`  skipped (bust):  ${totalSkips}`);
  console.log(`  bust events:     ${bust}  ${bust > 0 ? `(redeposited $${ACCT_INIT * bust} total)` : ""}`);
  console.log(`  starting bal:    $${ACCT_INIT}`);
  console.log(`  final bal:       $${bal.toFixed(2)}  (Δ ${bal - ACCT_INIT >= 0 ? "+" : ""}$${(bal - ACCT_INIT).toFixed(2)} = ${((bal - ACCT_INIT)/ACCT_INIT*100).toFixed(1)}%)`);
  console.log(`  peak / trough:   $${peak.toFixed(2)} / $${trough.toFixed(2)}`);
  console.log(`  max drawdown:    $${maxDD.toFixed(2)}  (${(maxDD/peak*100).toFixed(1)}% of peak)`);

  console.log(`\nPer-symbol contribution:`);
  console.log(`  ${"sym".padEnd(10)} bets    W/L          WR     net        maxLadder  longestL  skipped`);
  for (const s of Array.from(stats.values())) {
    const swr = s.bets > 0 ? (s.wins / s.bets * 100).toFixed(1) : "—";
    console.log(`  ${s.sym.padEnd(10)} ${s.bets.toString().padStart(5)}   ${s.wins.toString().padStart(4)}/${s.losses.toString().padStart(4)}    ${swr.padStart(5)}%  ${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2).padStart(8)}  L${s.maxLadder.toString().padStart(2)}        ${s.longestL.toString().padStart(2)}        ${s.skipped}`);
  }

  // 10-min snapshot of balance trajectory
  console.log(`\nBalance trajectory (10-min snapshots):`);
  console.log(`  ${"time (UTC)".padEnd(12)} balance     change`);
  const startT = balOverTime[0].epoch;
  const buckets = new Map<number, number>();
  for (const b of balOverTime) {
    const minute = Math.floor((b.epoch - startT) / 600); // 10-min buckets
    buckets.set(minute, b.bal); // last-in-bucket
  }
  let prev = ACCT_INIT;
  for (const [bucket, b] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
    const ts = new Date((startT + bucket * 600) * 1000).toISOString().slice(11, 16);
    const ch = b - prev;
    console.log(`  ${ts.padEnd(12)} $${b.toFixed(2).padStart(8)}   ${ch >= 0 ? "+" : ""}$${ch.toFixed(2)}`);
    prev = b;
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
