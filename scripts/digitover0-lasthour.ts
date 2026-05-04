// Last-hour DIGITOVER 0 simulation. Predict next tick's digit > 0 (i.e.
// digit ∈ {1..9}). Win pays 1.09× (broker-priced as if 0-9 uniform),
// actual win rate is 99% on synthetic indices because digit 0 is missing.
//
// Uses real Deriv proposal payouts. $41 acct, $1 flat stake (no mart
// needed — 99% WR means losses are rare and shallow).
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/digitover0-lasthour.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V", "JD75"];
const ACCT_INIT = 41;
const STAKE = 1;
const ONE_HOUR = 3600;

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
        const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
    });
  }
  send(req: any) {
    return new Promise<any>((resolve, reject) => {
      const id = this.reqId++; this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout")); } }, 30_000);
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

async function fetchTicks(c: C, sym: string, count: number): Promise<{ epoch: number[]; quote: number[] }> {
  const PAGE = 5000; let end: any = "latest"; const epoch: number[] = []; const quote: number[] = []; let remaining = count;
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
    end = h.times[0] - 1; remaining -= h.times.length;
  }
  return { epoch, quote };
}

async function main() {
  const c = new C(); await c.ready;
  await c.send({ authorize: TOKEN });
  console.log(`Last-hour DIGITOVER 0 sim — $${ACCT_INIT} acct · $${STAKE} flat stake · 8 symbols\n`);
  console.log(`Predict: next tick's digit > 0. Win = digit ∈ {1..9}. Loss = digit = 0.\n`);

  type Result = { sym: string; ticks: number; bets: number; wins: number; losses: number; payout: number; net: number; finalBal: number; maxDD: number; longestL: number };
  const results: Result[] = [];

  for (const sym of SYMBOLS) {
    process.stdout.write(`${sym}: fetching last hour... `);
    // Fetch enough to filter to last 3600s
    const all = await fetchTicks(c, sym, 6000);
    if (all.epoch.length === 0) { console.log("no data"); continue; }
    const latest = all.epoch[all.epoch.length - 1];
    const fromEpoch = latest - ONE_HOUR;
    const idx = all.epoch.findIndex((e) => e >= fromEpoch);
    const quotes = idx < 0 ? [] : all.quote.slice(idx);
    if (quotes.length === 0) { console.log("no last-hour ticks"); continue; }

    // Get the actual proposal payout for DIGITOVER 0
    let payout = 1.09;
    try {
      const p = await c.send({
        proposal: 1, amount: 1, basis: "stake",
        contract_type: "DIGITOVER", currency: "USD",
        duration: 1, duration_unit: "t",
        symbol: sym, barrier: "0",
      });
      if (p.proposal?.payout) payout = p.proposal.payout;
    } catch { /* fall back to 1.09 */ }

    const fromTime = new Date((latest - ONE_HOUR) * 1000).toISOString().slice(11, 19);
    const toTime = new Date(latest * 1000).toISOString().slice(11, 19);
    console.log(`${quotes.length} ticks  ${fromTime}→${toTime}  payout=${payout.toFixed(3)}×`);

    // Simulate: every tick, bet $1 on DIGITOVER 0. Settles on next tick.
    let bal = ACCT_INIT, peak = ACCT_INIT, maxDD = 0;
    let bets = 0, wins = 0, losses = 0, net = 0, longestL = 0, curStreak = 0;

    for (let i = 0; i < quotes.length - 1; i++) {
      // Bet at tick i, settle at tick i+1
      bets++;
      const settleDigit = lastDigit(quotes[i + 1]);
      if (settleDigit > 0) {
        const profit = STAKE * (payout - 1);
        bal = Math.round((bal + profit) * 100) / 100;
        net += profit;
        wins++;
        curStreak = 0;
      } else {
        bal = Math.round((bal - STAKE) * 100) / 100;
        net -= STAKE;
        losses++;
        curStreak++;
        if (curStreak > longestL) longestL = curStreak;
      }
      if (bal > peak) peak = bal;
      const dd = peak - bal;
      if (dd > maxDD) maxDD = dd;
    }

    results.push({
      sym, ticks: quotes.length, bets, wins, losses, payout,
      net: Math.round(net * 100) / 100,
      finalBal: bal,
      maxDD: Math.round(maxDD * 100) / 100,
      longestL,
    });
  }
  c.close();

  results.sort((a, b) => b.net - a.net);
  console.log(`\n${"".padEnd(115, "═")}`);
  console.log(`RESULTS — last 1 hour, DIGITOVER 0 at $${STAKE} flat stake`);
  console.log(`${"".padEnd(115, "═")}`);
  console.log(`${"sym".padEnd(10)} ${"ticks".padStart(5)} ${"bets".padStart(5)} ${"W".padStart(5)}/${"L".padStart(3)}  ${"WR".padStart(7)}  ${"payout".padStart(7)} ${"net".padStart(8)}  ${"finalBal".padStart(8)}  ${"maxDD".padStart(6)}  longestL`);
  let totBets = 0, totWins = 0, totNet = 0;
  for (const r of results) {
    const wr = r.bets > 0 ? r.wins / r.bets : 0;
    console.log(`${r.sym.padEnd(10)} ${String(r.ticks).padStart(5)} ${String(r.bets).padStart(5)} ${String(r.wins).padStart(5)}/${String(r.losses).padStart(3)}  ${(wr*100).toFixed(2).padStart(6)}%  ${r.payout.toFixed(3).padStart(7)} ${(r.net >= 0 ? "+" : "") + "$" + r.net.toFixed(2).padStart(7)}  $${r.finalBal.toFixed(2).padStart(7)}  $${r.maxDD.toFixed(2).padStart(5)}  ${String(r.longestL).padStart(2)}`);
    totBets += r.bets; totWins += r.wins; totNet += r.net;
  }
  console.log(`${"".padEnd(115, "─")}`);
  const totWR = totBets > 0 ? totWins / totBets : 0;
  console.log(`COMBINED book (8 parallel $${ACCT_INIT} accts, each $${STAKE} flat):`);
  console.log(`  bets=${totBets}  WR=${(totWR*100).toFixed(2)}%  net=${totNet >= 0 ? "+" : ""}$${totNet.toFixed(2)}/hr`);
  console.log(`  per-symbol avg: $${(totNet / results.length).toFixed(2)}/hr → $${(totNet * 24 / results.length).toFixed(2)}/24h`);
}
main().catch((e) => { console.error(e); process.exit(1); });
