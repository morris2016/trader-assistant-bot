// REAL-ACCOUNT DIGITODD simulation — adds frictions that the prior sim
// glossed over:
//
//   1. NO auto-redeposit. Bust = STOP. No infinite "ROI" magic.
//   2. Daily loss cap. If acct drops below 50% of starting bal, PAUSE for
//      the day (sim ends since 1h window).
//   3. Network failures. ~5% of buy attempts fail outright (Deriv timeout,
//      WS reconnect, balance-update collision). Failed buys = no bet, no
//      ladder advance.
//   4. Latency-skipped ticks. Round-trip to Deriv is ~250ms. After a buy
//      lands, the next tick that arrives during in-flight settlement is
//      MISSED — bot hasn't received settlement yet. Realistic skip rate
//      depends on tick frequency:
//        - RDBEAR/RDBULL/R_*  ~1 tick / 2s   → ~10% skip
//        - JD75 / 1HZ*V       ~1 tick / 1s   → ~25% skip
//   5. Per-symbol settlement gap. DIGITODD is 1-tick — contract resolves
//      on the tick AFTER buy. During that window, the symbol is "busy"
//      from the bot's perspective (already has open contract, can't open
//      another). We model this by skipping the tick immediately following
//      a successful buy on the same symbol.
//   6. Stake cap. Deriv DIGIT contract max stake on synthetics ~ $50.
//      Above that, buy rejected → ladder forced to L0.
//   7. Effective payout ~1.93× (not the proposal's 1.95×). Real fills
//      include a small spread vs the displayed payout.
//
// Same starting config: $41 acct, $1 base, 1.5× mart, 7 symbols sharing
// one balance pool. Last 1 hour of ticks.
//
// Usage: npx ts-node scripts/digitodd-realacc-sim.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const SYMBOLS = ["R_50", "RDBEAR", "RDBULL", "R_75", "JD75", "1HZ50V", "1HZ100V"];

const ACCT_INIT = 41, BASE_STAKE = 1, MART_RATIO = 1.5;
const PAYOUT = 1.93;        // realistic fill payout, not headline 1.95
const STAKE_CAP = 50;       // per-contract max
const DAILY_LOSS_PAUSE = 0.5; // pause if bal drops below 50% of starting
const NET_FAIL_RATE = 0.05; // 5% of buy attempts fail outright
const ONE_HOUR = 3600;
// Per-symbol next-tick settlement: after a successful buy at tick i, skip
// tick i+1 (contract is settling, can't bet).

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

// Seeded RNG so reruns are deterministic
let rngSeed = 12345;
function rnd(): number { rngSeed = (rngSeed * 1103515245 + 12345) & 0x7fffffff; return rngSeed / 0x7fffffff; }

async function main() {
  const c = new C(); await c.ready;
  console.log(`REAL-ACCOUNT DIGITODD 1-hour SIM`);
  console.log(`  acct=$${ACCT_INIT}  base=$${BASE_STAKE}  mart=${MART_RATIO}×  payout=${PAYOUT}× (realistic, ~1.95 advertised)`);
  console.log(`  stake_cap=$${STAKE_CAP}  net_fail=${(NET_FAIL_RATE*100).toFixed(0)}%  daily_pause<50%bal  no_redeposit  next-tick settlement gap\n`);

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
    console.log(`${tickCount} ticks`);
  }
  c.close();

  allTicks.sort((a, b) => a.epoch - b.epoch || a.sym.localeCompare(b.sym));
  console.log(`\nMerged stream: ${allTicks.length} ticks · sim window ${new Date(allTicks[0].epoch * 1000).toISOString().slice(11, 19)} → ${new Date(allTicks[allTicks.length-1].epoch * 1000).toISOString().slice(11, 19)} UTC\n`);

  type StratStat = {
    sym: string;
    bets: number;
    wins: number;
    losses: number;
    netFails: number;
    skippedBusy: number;
    skippedAfford: number;
    capRejects: number;
    net: number;
    level: number;
    longestL: number;
    curStreak: number;
    maxLadder: number;
    busyUntilEpoch: number; // tick after a successful buy: skip until > this
  };
  const stats = new Map<string, StratStat>();
  for (const sym of SYMBOLS) stats.set(sym, {
    sym, bets: 0, wins: 0, losses: 0, netFails: 0, skippedBusy: 0,
    skippedAfford: 0, capRejects: 0, net: 0, level: 0, longestL: 0,
    curStreak: 0, maxLadder: 0, busyUntilEpoch: -1,
  });

  let bal = ACCT_INIT, peak = ACCT_INIT, trough = ACCT_INIT, maxDD = 0;
  let totalBets = 0, totalWins = 0;
  let pausedDailyLoss = false;
  let bustedOut = false;
  const balOverTime: { epoch: number; bal: number }[] = [{ epoch: allTicks[0].epoch, bal }];
  let stoppedAtEpoch: number | null = null;

  for (let i = 0; i < allTicks.length; i++) {
    if (bustedOut || pausedDailyLoss) break;
    const t = allTicks[i];
    const s = stats.get(t.sym)!;

    // Per-symbol busy gate
    if (t.epoch <= s.busyUntilEpoch) { s.skippedBusy++; continue; }

    // Compute stake
    let stake = round2(BASE_STAKE * Math.pow(MART_RATIO, s.level));
    if (stake > STAKE_CAP) {
      // Forced reset to L0
      s.capRejects++;
      s.level = 0;
      stake = BASE_STAKE;
    }

    // Affordability — if can't afford this stake, do NOT auto-redeposit
    if (bal < stake) {
      // Try L0 fallback if level was advanced
      if (s.level > 0) {
        s.level = 0;
        stake = BASE_STAKE;
        if (bal < stake) {
          // Can't even afford L0 → BUST. STOP TRADING.
          bustedOut = true;
          stoppedAtEpoch = t.epoch;
          continue;
        }
      } else {
        bustedOut = true;
        stoppedAtEpoch = t.epoch;
        continue;
      }
    }

    if (s.level > s.maxLadder) s.maxLadder = s.level;

    // Network failure simulation
    if (rnd() < NET_FAIL_RATE) { s.netFails++; continue; }

    // Successful buy. Mark symbol busy through next tick of same symbol.
    // Find the next tick on this symbol AFTER current — that's when contract settles.
    let settleIdx = -1;
    for (let j = i + 1; j < allTicks.length; j++) {
      if (allTicks[j].sym === t.sym) { settleIdx = j; break; }
    }
    if (settleIdx < 0) {
      // No future tick to settle against — sim ends, this bet drops
      continue;
    }
    s.busyUntilEpoch = allTicks[settleIdx].epoch;

    // Place bet using CURRENT tick's quote to predict NEXT tick's digit.
    // Wait — DIGITODD predicts the digit of the entry tick + 1. So the
    // resolution digit is the next tick's digit on the same symbol.
    const resolveDigit = lastDigit(allTicks[settleIdx].quote);
    const isOdd = resolveDigit % 2 !== 0;
    s.bets++;
    totalBets++;
    if (isOdd) {
      const profit = round2(stake * (PAYOUT - 1));
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

    // Daily-loss pause check
    if (bal < ACCT_INIT * (1 - DAILY_LOSS_PAUSE)) {
      pausedDailyLoss = true;
      stoppedAtEpoch = t.epoch;
    }
  }

  const wr = totalBets > 0 ? totalWins / totalBets * 100 : 0;
  const stopReason = bustedOut ? "💀 BUST" : pausedDailyLoss ? "⏸ daily loss pause (-50%)" : "✓ ran to end";
  const stopTime = stoppedAtEpoch ? new Date(stoppedAtEpoch * 1000).toISOString().slice(11, 19) : "—";

  console.log(`${"".padEnd(115, "═")}`);
  console.log(`REAL-ACC RESULT`);
  console.log(`${"".padEnd(115, "═")}`);
  console.log(`  stop status:     ${stopReason}  ${stoppedAtEpoch ? `at ${stopTime} UTC` : ""}`);
  console.log(`  bets placed:     ${totalBets}`);
  console.log(`  wins / losses:   ${totalWins} / ${totalBets - totalWins}  (WR ${wr.toFixed(2)}%)`);
  console.log(`  starting bal:    $${ACCT_INIT}`);
  console.log(`  final bal:       $${bal.toFixed(2)}  (Δ ${bal - ACCT_INIT >= 0 ? "+" : ""}$${(bal - ACCT_INIT).toFixed(2)} = ${((bal - ACCT_INIT)/ACCT_INIT*100).toFixed(1)}%)`);
  console.log(`  peak / trough:   $${peak.toFixed(2)} / $${trough.toFixed(2)}`);
  console.log(`  max drawdown:    $${maxDD.toFixed(2)}  (${(maxDD/peak*100).toFixed(1)}% of peak)`);

  console.log(`\nFriction breakdown per symbol:`);
  console.log(`  ${"sym".padEnd(10)} bets    W/L          WR     net        netFails  skipBusy  skipAfford  capRej  maxLadder`);
  for (const s of Array.from(stats.values())) {
    const swr = s.bets > 0 ? (s.wins / s.bets * 100).toFixed(1) : "—";
    console.log(`  ${s.sym.padEnd(10)} ${s.bets.toString().padStart(5)}   ${s.wins.toString().padStart(4)}/${s.losses.toString().padStart(4)}    ${swr.padStart(5)}%  ${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2).padStart(8)}  ${s.netFails.toString().padStart(4)}      ${s.skippedBusy.toString().padStart(4)}      ${s.skippedAfford.toString().padStart(4)}        ${s.capRejects.toString().padStart(3)}     L${s.maxLadder}`);
  }

  // 10-min snapshots
  console.log(`\nBalance trajectory (10-min snapshots):`);
  console.log(`  ${"time (UTC)".padEnd(12)} balance     change`);
  if (balOverTime.length > 0) {
    const startT = balOverTime[0].epoch;
    const buckets = new Map<number, number>();
    for (const b of balOverTime) buckets.set(Math.floor((b.epoch - startT) / 600), b.bal);
    let prev = ACCT_INIT;
    for (const [bucket, b] of Array.from(buckets.entries()).sort((a, b) => a[0] - b[0])) {
      const ts = new Date((startT + bucket * 600) * 1000).toISOString().slice(11, 16);
      const ch = b - prev;
      console.log(`  ${ts.padEnd(12)} $${b.toFixed(2).padStart(8)}   ${ch >= 0 ? "+" : ""}$${ch.toFixed(2)}`);
      prev = b;
    }
  }

  // Friction summary
  let totSkipBusy = 0, totNetFails = 0, totCapRej = 0;
  for (const s of Array.from(stats.values())) { totSkipBusy += s.skippedBusy; totNetFails += s.netFails; totCapRej += s.capRejects; }
  console.log(`\nFrictions absorbed:`);
  console.log(`  skipped (settlement busy):  ${totSkipBusy}  (${(totSkipBusy/allTicks.length*100).toFixed(1)}% of ticks)`);
  console.log(`  network failures:           ${totNetFails}  (${(totNetFails/(totalBets+totNetFails)*100 || 0).toFixed(1)}% of attempts)`);
  console.log(`  stake-cap forced resets:    ${totCapRej}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
