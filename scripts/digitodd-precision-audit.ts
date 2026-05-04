// DIGITODD precision audit — verify whether the synthetic-RNG odd-digit
// bias is real or a JavaScript Number.toString() trailing-zero artifact.
//
// JS strips trailing zeros: Number(213.4570).toString() === "213.457".
// Deriv's contract evaluator uses fixed-precision (e.g. R_50 = 4 decimals)
// so digit 0 at position N+1 is INCLUDED. Our prior sim was reading the
// wrong digit on roughly 10% of ticks — exactly the missing-0 frequency
// we thought was "absent" from the synthetics.
//
// This script:
//   1. Pulls each symbol's pip precision from active_symbols
//   2. Fetches 50k ticks per symbol
//   3. Computes lastDigit using two methods:
//        BAD : Number.toString() (the bug)
//        GOOD: price.toFixed(decimals) (preserves trailing zeros)
//   4. Reports both P(odd) values + computed EV at 1.95× DIGITODD payout
//   5. Verdict: is there real edge, or was it all parser bug?
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/digitodd-precision-audit.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = ["R_10", "R_25", "R_50", "R_75", "R_100", "1HZ50V", "1HZ100V", "JD75", "RDBEAR", "RDBULL"];
const TICK_COUNT = 50_000;

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

// BAD: the bug (JS strips trailing zeros)
function lastDigitBad(price: number): number {
  const s = price.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const dec = s.slice(dot + 1);
  if (dec.length === 0) return 0;
  return Number(dec[dec.length - 1]);
}

// GOOD: fixed-precision per symbol pipSize → last char of toFixed string
function lastDigitGood(price: number, decimals: number): number {
  const s = price.toFixed(decimals);
  return Number(s[s.length - 1]);
}

async function main() {
  const c = new C(); await c.ready;
  await c.send({ authorize: TOKEN });
  console.log(`DIGITODD precision audit — ${TICK_COUNT} ticks per symbol\n`);

  // Pull active symbols to get pip per symbol
  const as = await c.send({ active_symbols: "brief", product_type: "basic" });
  const sympips = new Map<string, number>();
  for (const sym of (as.active_symbols ?? []) as any[]) {
    if (sym.symbol && sym.pip) sympips.set(sym.symbol, Number(sym.pip));
  }

  console.log(`${"sym".padEnd(10)} pip      decimals  ticks   ${"P(odd) BAD".padStart(11)} ${"P(odd) GOOD".padStart(12)}  diff    ${"EV BAD/$1".padStart(11)} ${"EV GOOD/$1".padStart(11)}  verdict`);
  console.log(`${"".padEnd(120, "─")}`);

  for (const sym of SYMBOLS) {
    process.stderr.write(`fetching ${sym}... `);
    const pip = sympips.get(sym);
    if (pip == null) { console.error(`no pip for ${sym}`); continue; }
    const decimals = Math.max(0, -Math.log10(pip));
    const decRound = Math.round(decimals);

    // Fetch ticks
    const PAGE = 5000;
    let end: any = "latest";
    const quotes: number[] = [];
    let remaining = TICK_COUNT;
    while (remaining > 0) {
      const ask = Math.min(PAGE, remaining);
      let r: any;
      try { r = await c.send({ ticks_history: sym, count: ask, end: String(end), style: "ticks", adjust_start_time: 1 }); }
      catch { break; }
      const h = r.history;
      if (!h?.times?.length) break;
      quotes.unshift(...(h.prices as number[]));
      if (h.times.length < ask) break;
      end = h.times[0] - 1;
      remaining -= h.times.length;
    }
    if (quotes.length < 1000) { console.error(`thin (${quotes.length})`); continue; }

    // Count odd by both methods
    let oddBad = 0, oddGood = 0;
    for (const q of quotes) {
      if (lastDigitBad(q) % 2 !== 0) oddBad++;
      if (lastDigitGood(q, decRound) % 2 !== 0) oddGood++;
    }
    const pBad = oddBad / quotes.length;
    const pGood = oddGood / quotes.length;
    const evBad = pBad * 0.95 - (1 - pBad);
    const evGood = pGood * 0.95 - (1 - pGood);
    const verdict = evGood > 0.01 ? "★ real edge" : evGood > -0.01 ? "fair-priced" : "negative — DO NOT TRADE";

    process.stderr.write("\r" + " ".repeat(40) + "\r");
    console.log(`${sym.padEnd(10)} ${pip.toFixed(5).padEnd(8)} ${String(decRound).padStart(8)}  ${String(quotes.length).padStart(5)}  ${(pBad*100).toFixed(2).padStart(9)}%  ${(pGood*100).toFixed(2).padStart(10)}%  ${((pBad-pGood)*100 >= 0 ? "+" : "") + ((pBad-pGood)*100).toFixed(2)}pp  ${(evBad >= 0 ? "+" : "") + "$" + evBad.toFixed(4).padStart(9)}  ${(evGood >= 0 ? "+" : "") + "$" + evGood.toFixed(4).padStart(9)}   ${verdict}`);
  }
  c.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
