// Tick-level strategy screener for Deriv DIGIT* and CALL/PUT contracts.
//
// Tests multiple hypotheses on synthetic tick streams:
//   (A) Last-digit base-rate bias (DIGITEVEN/ODD/OVER/UNDER): are the digits
//       uniformly distributed? If digit 7 shows up 11% instead of 10%,
//       DIGITDIFF=7 has +1% edge per tick (payout=8.7× → BIG margin).
//   (B) Last-digit Markov bias: P(next digit | prev digit) — any conditional
//       deviation from uniform?
//   (C) Streak-based digit prediction: after N evens, P(odd) > 0.5?
//   (D) Tick rise/fall (CALL/PUT) after various conditions:
//       - N consecutive ups/downs → next tick / next 5 ticks
//       - Range/volatility regime → momentum continuation or reversion
//
// For each hypothesis, count trials & wins, compute WR + EV at standard
// payouts. Anything with WR > 53% (CALL/PUT) or WR > 11.3% (DIGITDIFF, where
// payout is 8.7× so breakeven=10.3%) is a deployable candidate.
//
// Usage: npx ts-node scripts/tick-digit-callput-screen.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOLS = ["RDBEAR", "RDBULL", "JD75", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V"];
const TICK_COUNT = 50000;  // ~14h worth of ticks at 1Hz, ~28h at 2Hz

// Payouts (rough Deriv defaults; actual varies but these are realistic anchors)
const PAYOUT_CALLPUT = 0.95;       // breakeven WR = 51.3%
const PAYOUT_DIGITEVENODD = 0.95;  // breakeven WR = 51.3%
const PAYOUT_DIGITOVERUNDER = { over0: 0.10, over1: 0.21, over2: 0.36, over3: 0.55, over4: 0.78, over5: 1.10, over6: 1.55, over7: 2.32, over8: 3.86 }; // approximate
const PAYOUT_DIGITDIFF = 8.0;      // matches single digit, breakeven = 11.1%
const PAYOUT_DIGITMATCH = 8.0;     // same

class C { ws: any; reqId = 1; pending = new Map<number, any>(); ready!: Promise<void>;
  constructor() { const WS = require("ws"); this.ws = new WS(WS_URL); this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => { try { const m = JSON.parse(String(raw)); const id = m.req_id; if (id != null && this.pending.has(id)) { const { resolve, reject } = this.pending.get(id)!; this.pending.delete(id); if (m.error) reject(new Error(m.error.message)); else resolve(m); } } catch {} }); }
  send(req: any) { return new Promise<any>((resolve, reject) => { const id = this.reqId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ ...req, req_id: id })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout`)); } }, 30_000); }); }
  close() { try { this.ws.close(); } catch {} } }

async function fetchTicks(c: C, sym: string, count: number): Promise<{ epoch: number[]; quote: number[] }> {
  // ticks_history returns up to 5000 per call; page backwards.
  const PAGE = 5000;
  let end: any = "latest";
  const allEpochs: number[] = [], allQuotes: number[] = [];
  let remaining = count;
  while (remaining > 0) {
    const ask = Math.min(PAGE, remaining);
    let r: any;
    try { r = await c.send({ ticks_history: sym, count: ask, end: String(end), style: "ticks", adjust_start_time: 1 }); }
    catch (e) { console.error(`  fetch fail ${end}: ${(e as Error).message}`); break; }
    const h = r.history;
    if (!h || !h.times || h.times.length === 0) break;
    // unshift in chronological order (oldest first)
    allEpochs.unshift(...h.times);
    allQuotes.unshift(...(h.prices as number[]));
    if (h.times.length < ask) break;
    end = h.times[0] - 1;
    remaining -= h.times.length;
  }
  return { epoch: allEpochs, quote: allQuotes };
}

function lastDigit(price: number): number {
  // Deriv quotes: synthetic indices typically have 2-4 decimal places. Last
  // digit = the rightmost meaningful decimal in the displayed quote. For
  // accuracy, we extract from the string representation.
  const s = price.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const dec = s.slice(dot + 1);
  if (dec.length === 0) return 0;
  return Number(dec[dec.length - 1]);
}

type Stat = { n: number; wins: number; ev?: number };
function newStat(): Stat { return { n: 0, wins: 0 }; }

async function main() {
  const c = new C(); await c.ready;

  console.log(`TICK-LEVEL DIGIT + CALL/PUT SCREENER`);
  console.log(`Pulling ${TICK_COUNT} ticks per symbol (best-effort)\n`);

  const results: { sym: string; rows: { name: string; n: number; wins: number; wr: number; ev: number; verdict: string }[] }[] = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym} fetching... `);
    let data: { epoch: number[]; quote: number[] };
    try { data = await fetchTicks(c, sym, TICK_COUNT); }
    catch (e) { console.log(`fail: ${(e as Error).message}`); continue; }
    if (data.epoch.length < 1000) { console.log(`only ${data.epoch.length} ticks — skip`); continue; }
    console.log(`${data.epoch.length} ticks  span=${((data.epoch[data.epoch.length-1] - data.epoch[0])/3600).toFixed(1)}h`);
    const Q = data.quote;
    const N = Q.length;
    const rows: { name: string; n: number; wins: number; wr: number; ev: number; verdict: string }[] = [];

    // ── (A) Last-digit base-rate distribution ──
    const digitCount = new Array(10).fill(0);
    for (const q of Q) digitCount[lastDigit(q)]++;
    // For each digit d, DIGITDIFF != d wins if next tick's digit != d.
    // We're testing single-tick: "predict next digit will be d" = DIGITMATCH d. Win if eq.
    for (let d = 0; d <= 9; d++) {
      const wins = digitCount[d];
      const wr = wins / N;
      const ev = wr * PAYOUT_DIGITMATCH - (1 - wr);
      const verdict = wr >= 0.115 ? "★ digit_match deployable" : wr <= 0.085 ? "★ digit_diff deployable" : "uniform";
      rows.push({ name: `MATCH d=${d}`, n: N, wins, wr, ev, verdict });
    }
    // EVEN/ODD direct test
    let evens = 0; for (const q of Q) if (lastDigit(q) % 2 === 0) evens++;
    rows.push({
      name: "EVEN", n: N, wins: evens,
      wr: evens / N,
      ev: (evens / N) * PAYOUT_DIGITEVENODD - (1 - evens/N),
      verdict: evens / N >= 0.535 ? "★ DIGITEVEN deployable" : evens / N <= 0.465 ? "★ DIGITODD deployable" : "near-uniform",
    });
    rows.push({
      name: "ODD",  n: N, wins: N - evens,
      wr: 1 - evens / N,
      ev: (1 - evens/N) * PAYOUT_DIGITEVENODD - evens/N,
      verdict: "—",
    });
    // OVER/UNDER barriers (digit > b vs ≤ b)
    for (let b = 0; b <= 8; b++) {
      let over = 0; for (const q of Q) if (lastDigit(q) > b) over++;
      const wr = over / N;
      const verdict = wr > 0.535 ? "★ OVER deployable" : wr < 0.465 ? "★ UNDER deployable" : "—";
      rows.push({ name: `OVER>${b}`, n: N, wins: over, wr, ev: 0, verdict });
    }

    // ── (B) Last-digit Markov bias: P(next digit | prev digit) ──
    // Look at conditional probs. If one (prev,next) cell deviates strongly
    // from 10%, that's a 1-tick conditional digit bet edge.
    const trans = Array.from({ length: 10 }, () => new Array(10).fill(0));
    const prevCount = new Array(10).fill(0);
    for (let i = 1; i < N; i++) {
      const p = lastDigit(Q[i - 1]); const nx = lastDigit(Q[i]);
      trans[p][nx]++; prevCount[p]++;
    }
    let bestCond: { name: string; n: number; wins: number; wr: number; ev: number; verdict: string } | null = null;
    for (let p = 0; p <= 9; p++) {
      for (let nx = 0; nx <= 9; nx++) {
        if (prevCount[p] < 100) continue;
        const wr = trans[p][nx] / prevCount[p];
        if (wr > 0.13 || wr < 0.07) {
          const ev = wr * PAYOUT_DIGITMATCH - (1 - wr);
          const cand = {
            name: `prev=${p} → next=${nx}`,
            n: prevCount[p], wins: trans[p][nx], wr, ev,
            verdict: wr > 0.13 ? "★ Markov MATCH" : "★ Markov DIFF",
          };
          if (!bestCond || Math.abs(cand.wr - 0.10) > Math.abs(bestCond.wr - 0.10)) bestCond = cand;
        }
      }
    }
    if (bestCond) rows.push(bestCond);

    // ── (C) Streak digit prediction: after k same-parity in a row ──
    for (const k of [3, 5, 7]) {
      let trials = 0, evenAfterEvenStreak = 0;
      for (let i = k; i < N; i++) {
        let allEven = true;
        for (let j = i - k; j < i; j++) if (lastDigit(Q[j]) % 2 !== 0) { allEven = false; break; }
        if (!allEven) continue;
        trials++;
        if (lastDigit(Q[i]) % 2 === 0) evenAfterEvenStreak++;
      }
      if (trials >= 100) {
        const wr = evenAfterEvenStreak / trials;
        const ev = wr * PAYOUT_DIGITEVENODD - (1 - wr);
        const verdict = wr >= 0.535 ? `★ even after ${k}E streak` : wr <= 0.465 ? `★ odd after ${k}E streak` : "—";
        rows.push({ name: `${k}× EVEN → P(even next)`, n: trials, wins: evenAfterEvenStreak, wr, ev, verdict });
      }
    }

    // ── (D) Rise/Fall after N up/down ticks ──
    for (const k of [1, 3, 5, 10]) {
      // After k consecutive up moves, P(next tick up)
      let trialsUp = 0, winUp = 0, trialsDn = 0, winDn = 0;
      for (let i = k; i < N - 1; i++) {
        let allUp = true, allDn = true;
        for (let j = i - k; j < i; j++) {
          if (Q[j + 1] - Q[j] <= 0) allUp = false;
          if (Q[j + 1] - Q[j] >= 0) allDn = false;
          if (!allUp && !allDn) break;
        }
        const next = Q[i + 1] - Q[i];
        if (next === 0) continue;
        if (allUp) { trialsUp++; if (next > 0) winUp++; }
        if (allDn) { trialsDn++; if (next < 0) winDn++; }
      }
      if (trialsUp >= 50) {
        const wr = winUp / trialsUp;
        const ev = wr * PAYOUT_CALLPUT - (1 - wr);
        const verdict = wr >= 0.535 ? `★ continuation CALL` : wr <= 0.465 ? `★ fade PUT` : "—";
        rows.push({ name: `${k}× UP → next UP`, n: trialsUp, wins: winUp, wr, ev, verdict });
      }
      if (trialsDn >= 50) {
        const wr = winDn / trialsDn;
        const ev = wr * PAYOUT_CALLPUT - (1 - wr);
        const verdict = wr >= 0.535 ? `★ continuation PUT` : wr <= 0.465 ? `★ fade CALL` : "—";
        rows.push({ name: `${k}× DN → next DN`, n: trialsDn, wins: winDn, wr, ev, verdict });
      }
    }

    results.push({ sym, rows });
  }
  c.close();

  // Print only the deployable rows
  console.log(`\n${"".padEnd(120, "═")}`);
  console.log(`DEPLOYABLE CANDIDATES (rows with ★ verdict):`);
  console.log(`${"".padEnd(120, "═")}`);
  console.log(`${"symbol".padEnd(10)} ${"strategy".padEnd(28)} n         wins    WR        EV         verdict`);
  for (const r of results) {
    for (const row of r.rows) {
      if (!row.verdict.includes("★")) continue;
      console.log(`${r.sym.padEnd(10)} ${row.name.padEnd(28)} ${String(row.n).padStart(6)}    ${String(row.wins).padStart(6)}  ${(row.wr*100).toFixed(2).padStart(6)}%   ${row.ev >= 0 ? "+" : ""}${row.ev.toFixed(4).padStart(7)}    ${row.verdict}`);
    }
  }

  // Also print full per-symbol table for context
  console.log(`\n${"".padEnd(120, "═")}`);
  console.log(`FULL SCAN per symbol (all rows):`);
  console.log(`${"".padEnd(120, "═")}`);
  for (const r of results) {
    console.log(`\n${r.sym}:`);
    for (const row of r.rows) {
      const flag = row.verdict.includes("★") ? "★" : " ";
      console.log(`  ${flag} ${row.name.padEnd(28)} n=${String(row.n).padStart(5)} wins=${String(row.wins).padStart(5)} WR=${(row.wr*100).toFixed(2).padStart(5)}% EV=${row.ev >= 0 ? "+" : ""}${row.ev.toFixed(4)} ${row.verdict.includes("★") ? row.verdict : ""}`);
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
