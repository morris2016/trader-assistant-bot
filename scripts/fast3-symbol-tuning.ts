// Per-symbol DIGIT-strategy tuning research. For each underperforming
// symbol (JD75, 1HZ100V, R_75, RDBULL, RDBEAR), check:
//
//   1. Last-digit distribution — is the symbol's bias actually "odd"?
//      Some synthetics may be even-biased, in which case DIGITEVEN would
//      flip the edge from negative to positive.
//
//   2. DIGITOVER 4 / UNDER 5 alternatives — same bias from a different angle.
//      For example if a symbol has digits 5-9 over-represented vs 0-4,
//      DIGITOVER 4 captures it more directly than DIGITODD.
//
//   3. Streak-conditional edges — does the bias strengthen after K
//      consecutive same-side ticks? (Regression-to-mean signal.)
//
//   4. ALL TEN match probabilities — DIGITMATCH-X for the rare digit
//      with low probability becomes DIGITDIFF-X with a high WR.
//
// Pulls 50k+ ticks per symbol from the live API, computes empirical
// distributions, recommends best DIGIT contract per symbol.
//
// Usage: npx ts-node scripts/fast3-symbol-tuning.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ10V", "1HZ25V", "1HZ50V", "1HZ75V", "1HZ100V", "JD75", "RDBULL", "RDBEAR"];
const TICK_COUNT = 80_000;

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

async function fetchTicks(c: C, sym: string, count: number): Promise<number[]> {
  const PAGE = 5000; let end: any = "latest"; const all: number[] = []; let remaining = count;
  while (remaining > 0) {
    const ask = Math.min(PAGE, remaining);
    let r: any;
    try { r = await c.send({ ticks_history: sym, count: ask, end: String(end), style: "ticks", adjust_start_time: 1 }); }
    catch { break; }
    const h = r.history;
    if (!h || !h.times || h.times.length === 0) break;
    all.unshift(...(h.prices as number[]));
    if (h.times.length < ask) break;
    end = h.times[0] - 1;
    remaining -= h.times.length;
  }
  return all;
}

// Deriv payouts (researched 2026-05-03)
const PAYOUT_ODD_EVEN = 1.95;
const PAYOUT_ODD_EVEN_R100 = 1.92;
// DIGITOVER/UNDER and DIGITMATCH/DIFF payouts vary per barrier digit per symbol.
// Approximate: priced so the broker keeps ~5% house edge against fair odds.
function payoutOddEven(sym: string): number { return sym === "R_100" ? PAYOUT_ODD_EVEN_R100 : PAYOUT_ODD_EVEN; }

async function main() {
  const c = new C(); await c.ready;
  console.log(`Per-symbol DIGIT tuning research — ${TICK_COUNT}-tick window per symbol\n`);

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym}: fetching ${TICK_COUNT} ticks... `);
    const Q = await fetchTicks(c, sym, TICK_COUNT);
    if (Q.length < 1000) { console.log(`only ${Q.length} ticks — skip`); continue; }
    console.log(`${Q.length} ticks`);

    // ── Digit distribution ──
    const digitCount = new Array(10).fill(0);
    for (const q of Q) digitCount[lastDigit(q)]++;
    let odd = 0; for (const q of Q) if (lastDigit(q) % 2 !== 0) odd++;
    const oddPct = odd / Q.length;
    const evenPct = 1 - oddPct;
    const payout = payoutOddEven(sym);
    const oddEV = oddPct * (payout - 1) - (1 - oddPct);
    const evenEV = evenPct * (payout - 1) - (1 - evenPct);

    console.log(`  digit distribution (% of ticks):`);
    let line = "    ";
    for (let d = 0; d <= 9; d++) {
      const pct = digitCount[d] / Q.length * 100;
      const bias = pct > 11.5 ? "↑" : pct < 8.5 ? "↓" : " ";
      line += `${d}:${pct.toFixed(1)}%${bias}  `;
    }
    console.log(line);
    console.log(`  ODD/EVEN: P(odd)=${(oddPct*100).toFixed(2)}% P(even)=${(evenPct*100).toFixed(2)}% — payout ${payout}× → ODD EV/$1=${oddEV >= 0 ? "+" : ""}$${oddEV.toFixed(4)}, EVEN EV/$1=${evenEV >= 0 ? "+" : ""}$${evenEV.toFixed(4)}`);

    // ── OVER/UNDER barrier sweep ──
    const overEVs: { barrier: number; pct: number }[] = [];
    for (let b = 0; b <= 8; b++) {
      let over = 0;
      for (const q of Q) if (lastDigit(q) > b) over++;
      const pct = over / Q.length;
      overEVs.push({ barrier: b, pct });
    }
    // Show OVER>4 (digits 5-9) explicitly — closest equivalent to "lots of high digits"
    const o4 = overEVs.find((x) => x.barrier === 4)!;
    const u5 = 1 - o4.pct;
    console.log(`  OVER>4: ${(o4.pct*100).toFixed(2)}%   UNDER≤4: ${(u5*100).toFixed(2)}%`);

    // ── DIGITDIFF on rarest digit ──
    let rarestD = 0, rarestPct = digitCount[0] / Q.length;
    for (let d = 1; d <= 9; d++) {
      if (digitCount[d] / Q.length < rarestPct) { rarestPct = digitCount[d] / Q.length; rarestD = d; }
    }
    const diffWR = 1 - rarestPct;
    // DIGITDIFF payout is ~ rarestPct/(1-rarestPct) — broker prices around true odds.
    // Empirical: real Deriv DIGITDIFF payouts cap at ~10% return when digit is ~10% frequency.
    console.log(`  rarest digit: ${rarestD} appears ${(rarestPct*100).toFixed(2)}%; DIGITDIFF=${rarestD} would win ${(diffWR*100).toFixed(2)}% — useful only if Deriv mis-prices`);

    // ── Streak after-K conditional ODD ──
    let trials3 = 0, win3 = 0;
    for (let i = 3; i < Q.length; i++) {
      let allEven = true;
      for (let j = i - 3; j < i; j++) if (lastDigit(Q[j]) % 2 !== 0) { allEven = false; break; }
      if (!allEven) continue;
      trials3++;
      if (lastDigit(Q[i]) % 2 !== 0) win3++;
    }
    const condWR = trials3 > 0 ? win3 / trials3 : 0;
    if (trials3 >= 50) {
      const condEV = condWR * (payout - 1) - (1 - condWR);
      console.log(`  ODD after 3 evens: trials=${trials3}, WR=${(condWR*100).toFixed(2)}%, EV/$1=${condEV >= 0 ? "+" : ""}$${condEV.toFixed(4)} ${condWR > oddPct + 0.005 ? "★ better than baseline" : ""}`);
    }

    // ── Verdict ──
    const breakevenWR = 1 / payout;
    let recommendation = "skip";
    let bestEV = -Infinity;
    if (oddEV > bestEV) { bestEV = oddEV; recommendation = `DIGITODD (WR ${(oddPct*100).toFixed(2)}%, EV ${oddEV >= 0 ? "+" : ""}$${oddEV.toFixed(4)}/$1)`; }
    if (evenEV > bestEV) { bestEV = evenEV; recommendation = `DIGITEVEN (WR ${(evenPct*100).toFixed(2)}%, EV ${evenEV >= 0 ? "+" : ""}$${evenEV.toFixed(4)}/$1)`; }
    const verdict = bestEV > 0.005 ? "★ deployable" : bestEV > -0.005 ? "marginal" : "negative — DO NOT DEPLOY";
    console.log(`  → best contract: ${recommendation}`);
    console.log(`     verdict: ${verdict}  (breakeven WR @ payout ${payout}× = ${(breakevenWR*100).toFixed(2)}%)`);
    console.log();
  }
  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
