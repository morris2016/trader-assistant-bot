// Validate the DIGITODD bias by:
//   1. Querying Deriv's proposal endpoint for the ACTUAL payout on each symbol.
//      Deriv prices around their RNG bias, so the headline "55% WR at 95%
//      payout = +$3.5k/day" is almost certainly wrong. We need the real ratio.
//   2. If real payout × WR > 1.0, run TRAIN/TEST split on the bias to confirm
//      stability across 24h windows.
//   3. Tweak: martingale ladder, only-bet-after-streak conditions.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/tick-digit-validate.ts

const APP_ID = "1089"; const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = ["RDBEAR", "RDBULL", "JD75", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V"];
const TICK_COUNT = 50000;

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

async function getProposal(c: C, sym: string, contractType: string, stake = 1): Promise<{ payout: number; ratio: number } | null> {
  try {
    const r = await c.send({
      proposal: 1,
      amount: stake,
      basis: "stake",
      contract_type: contractType,
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      symbol: sym,
    });
    const p = r.proposal;
    if (!p) return null;
    return { payout: p.payout, ratio: p.payout / stake };
  } catch (e) {
    return null;
  }
}

async function main() {
  const c = new C(); await c.ready;
  await c.send({ authorize: TOKEN });
  console.log(`TICK DIGIT VALIDATION — actual Deriv payouts vs RNG bias\n`);

  // ── Phase 1: real proposal payouts per symbol ──
  console.log(`PHASE 1: real Deriv DIGITODD/EVEN payouts (1-tick, $1 stake)`);
  console.log(`${"sym".padEnd(10)} DIGITODD payout    ratio    DIGITEVEN payout    ratio    breakeven_WR_for_ODD`);
  const payoutMap: Record<string, { odd: number; even: number }> = {};
  for (const sym of SYMBOLS) {
    const odd = await getProposal(c, sym, "DIGITODD");
    const even = await getProposal(c, sym, "DIGITEVEN");
    payoutMap[sym] = { odd: odd?.ratio ?? 0, even: even?.ratio ?? 0 };
    const beWR = odd ? 1 / odd.ratio : 0;
    console.log(`${sym.padEnd(10)} $${(odd?.payout ?? 0).toFixed(4)}             ${(odd?.ratio ?? 0).toFixed(4)}×  $${(even?.payout ?? 0).toFixed(4)}              ${(even?.ratio ?? 0).toFixed(4)}×  ${(beWR * 100).toFixed(2)}%`);
  }

  // ── Phase 2: actual WR over 24h+, compute EV with REAL payouts ──
  console.log(`\nPHASE 2: actual digit distribution + EV vs real payouts\n`);
  console.log(`${"sym".padEnd(10)} ticks   ODD_count  ODD_WR   ODD_EV($1 stake)    EVEN_WR  EVEN_EV     verdict`);
  type Row = { sym: string; ticks: number; oddWR: number; oddEV: number; evenEV: number; betterSide: "ODD" | "EVEN" | null; betterEV: number };
  const rows: Row[] = [];
  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym.padEnd(10)} fetching... `);
    const Q = await fetchTicks(c, sym, TICK_COUNT);
    if (Q.length < 1000) { console.log(`thin`); continue; }
    let odd = 0;
    for (const q of Q) if (lastDigit(q) % 2 !== 0) odd++;
    const oddWR = odd / Q.length;
    const evenWR = 1 - oddWR;
    const pmap = payoutMap[sym];
    const oddEV = oddWR * (pmap.odd - 1) + (1 - oddWR) * (-1);  // payout includes stake → profit = (payout-1) on win, -1 on loss
    const evenEV = evenWR * (pmap.even - 1) + (1 - evenWR) * (-1);
    const betterEV = Math.max(oddEV, evenEV);
    const betterSide = betterEV === oddEV ? "ODD" : "EVEN";
    const verdict = betterEV > 0.01 ? `★ ${betterSide} edge +${(betterEV*100).toFixed(2)}%/tick` : betterEV > -0.005 ? "near breakeven" : "negative";
    console.log(`${Q.length.toString().padStart(5)}   ${String(odd).padStart(6)}     ${(oddWR*100).toFixed(2)}%  ${oddEV >= 0 ? "+" : ""}$${oddEV.toFixed(4)}            ${(evenWR*100).toFixed(2)}%  ${evenEV >= 0 ? "+" : ""}$${evenEV.toFixed(4)}    ${verdict}`);
    rows.push({ sym, ticks: Q.length, oddWR, oddEV, evenEV, betterSide, betterEV });
  }

  // ── Phase 3: train/test split on the best edge ──
  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`PHASE 3: TRAIN/TEST split on the strongest edge`);
  console.log(`${"".padEnd(110, "═")}`);
  const best = rows.filter((r) => r.betterEV > 0.005).sort((a, b) => b.betterEV - a.betterEV).slice(0, 5);
  if (best.length === 0) {
    console.log(`No symbol clears +0.5% EV after Deriv's real payouts. Edge is priced in.`);
    c.close(); return;
  }

  for (const r of best) {
    process.stdout.write(`${r.sym} — ${r.betterSide} side. Pulling fresh 80k ticks for split... `);
    const Q = await fetchTicks(c, r.sym, 80000);
    if (Q.length < 4000) { console.log(`thin`); continue; }
    const half = Math.floor(Q.length / 2);
    const train = Q.slice(0, half);
    const test = Q.slice(half);
    const pmap = payoutMap[r.sym];
    const ratio = r.betterSide === "ODD" ? pmap.odd : pmap.even;
    function evalSet(set: number[]): { wr: number; ev: number; net: number } {
      let wins = 0;
      for (const q of set) {
        const isOdd = lastDigit(q) % 2 !== 0;
        const won = (r.betterSide === "ODD" && isOdd) || (r.betterSide === "EVEN" && !isOdd);
        if (won) wins++;
      }
      const wr = wins / set.length;
      const ev = wr * (ratio - 1) - (1 - wr);
      const net = ev * set.length; // $1 stake per tick
      return { wr, ev, net };
    }
    const tr = evalSet(train);
    const te = evalSet(test);
    console.log(`${Q.length} ticks`);
    console.log(`  TRAIN ${train.length}t  WR=${(tr.wr*100).toFixed(2)}%  EV=$${tr.ev.toFixed(4)}/tick  net@$1=$${tr.net.toFixed(2)}  (${(tr.net / (train.length / 43200)).toFixed(2)}/day)`);
    console.log(`  TEST  ${test.length}t   WR=${(te.wr*100).toFixed(2)}%  EV=$${te.ev.toFixed(4)}/tick  net@$1=$${te.net.toFixed(2)}  (${(te.net / (test.length / 43200)).toFixed(2)}/day)`);
    const decay = ((te.ev - tr.ev) / Math.abs(tr.ev) * 100).toFixed(1);
    console.log(`  TEST vs TRAIN edge decay: ${decay}%  ${te.ev > 0 ? "(test still positive ★)" : "(test failed)"}`);
    console.log();
  }

  // ── Phase 4: tweak ideas ──
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`PHASE 4: tweaks on best edge — conditional bets only`);
  console.log(`${"".padEnd(110, "═")}`);
  if (best.length === 0) { c.close(); return; }
  const bestSym = best[0].sym;
  const pmap = payoutMap[bestSym];
  const ratio = best[0].betterSide === "ODD" ? pmap.odd : pmap.even;
  process.stdout.write(`${bestSym} — testing conditional triggers... `);
  const Q = await fetchTicks(c, bestSym, 80000);
  console.log(`${Q.length} ticks`);

  // Tweak 1: bet only after streak of opposite-side
  for (const k of [1, 2, 3, 5, 7]) {
    let trials = 0, wins = 0;
    for (let i = k; i < Q.length; i++) {
      let allOpposite = true;
      for (let j = i - k; j < i; j++) {
        const isOdd = lastDigit(Q[j]) % 2 !== 0;
        const oppositeOfBet = best[0].betterSide === "ODD" ? !isOdd : isOdd;
        if (!oppositeOfBet) { allOpposite = false; break; }
      }
      if (!allOpposite) continue;
      trials++;
      const isOdd = lastDigit(Q[i]) % 2 !== 0;
      const won = (best[0].betterSide === "ODD" && isOdd) || (best[0].betterSide === "EVEN" && !isOdd);
      if (won) wins++;
    }
    if (trials < 50) continue;
    const wr = wins / trials;
    const ev = wr * (ratio - 1) - (1 - wr);
    const verdict = ev > best[0].betterEV ? "★★ improves" : ev > 0 ? "still+" : "negative";
    console.log(`  bet ${best[0].betterSide} only after ${k} opposite ticks: trials=${trials}  WR=${(wr*100).toFixed(2)}%  EV=$${ev.toFixed(4)}  ${verdict}`);
  }

  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
