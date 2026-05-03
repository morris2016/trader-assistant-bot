// Detailed Deriv ladder analysis — group settled contracts by buy_price (stake)
// to infer martingale level. Shows where the losses concentrate.

const APP_ID = "1089";
const URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;

const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS_OF_INTEREST = ["BOOM300N", "CRASH300N", "RDBEAR"];

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => {
      try { const m = JSON.parse(String(raw)); const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch { /* */ }
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
  close() { try { this.ws.close(); } catch { /* */ } }
}

type Row = {
  contract_id: number;
  shortcode?: string;
  buy_price: number;
  sell_price: number;
  purchase_time: number;
  sell_time: number;
  longcode?: string;
  app_id?: number;
  transaction_id?: number;
};

function classify(longcode: string, shortcode: string): { sym: string; side: string } {
  let sym = "";
  for (const s of SYMBOLS_OF_INTEREST) {
    const niceMap: Record<string, string[]> = {
      BOOM300N:  ["BOOM 300", "BOOM_300N", "Boom 300"],
      CRASH300N: ["CRASH 300", "CRASH_300N", "Crash 300"],
      RDBEAR:    ["Bear Market Index", "RDBEAR"],
    };
    if (niceMap[s].some((kw) => longcode.includes(kw)) || (shortcode || "").includes(s)) {
      sym = s; break;
    }
  }
  let side = "?";
  const sc = shortcode || "";
  if (sc.includes("MULTUP")) side = "BUY";
  else if (sc.includes("MULTDOWN")) side = "SELL";
  return { sym, side };
}

// Bucket buy_price into mart levels assuming base $1.5, mart=1.7
function inferMartLevel(stake: number, base = 1.5, mart = 1.7): number {
  if (stake <= 0) return -1;
  for (let l = 0; l < 9; l++) {
    const expected = base * Math.pow(mart, l);
    if (Math.abs(stake - expected) / expected < 0.10) return l;
  }
  return -2; // unknown
}

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  console.log(`Authorized as ${auth.authorize?.loginid} (balance=${auth.authorize?.balance} ${auth.authorize?.currency})\n`);

  let allRows: Row[] = [];
  let offset = 0;
  while (allRows.length < 1000) {
    const r = await c.send({ profit_table: 1, limit: 100, offset, description: 1 });
    const tx = (r.profit_table?.transactions ?? []) as Row[];
    if (tx.length === 0) break;
    allRows.push(...tx);
    if (tx.length < 100) break;
    offset += 100;
  }
  c.close();
  console.log(`${allRows.length} settled contracts pulled\n`);

  type Settled = { sym: string; side: string; stake: number; pnl: number; ts: number; lvl: number };
  const settled: Settled[] = [];
  for (const r of allRows) {
    const { sym, side } = classify(r.longcode ?? "", r.shortcode ?? "");
    if (!sym) continue;
    const stake = r.buy_price ?? 0;
    settled.push({
      sym, side,
      stake,
      pnl: (r.sell_price ?? 0) - stake,
      ts: r.sell_time,
      lvl: inferMartLevel(stake),
    });
  }
  settled.sort((a, b) => a.ts - b.ts);

  // Per (sym, side, lvl) breakdown
  console.log(`${"".padEnd(90, "═")}`);
  console.log(`MARTINGALE LADDER LEVEL BREAKDOWN — (assume base $1.5 × 1.7^L)`);
  console.log(`${"".padEnd(90, "═")}`);
  console.log(`  symbol      side  lvl  stake     trades   W   L    WR     net          per-trade`);
  const groups = new Map<string, Settled[]>();
  for (const s of settled) {
    const key = `${s.sym}|${s.side}|${s.lvl}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const sorted = [...groups.entries()].sort((a, b) => {
    const [as, asd, al] = a[0].split("|");
    const [bs, bsd, bl] = b[0].split("|");
    if (as !== bs) return as.localeCompare(bs);
    if (asd !== bsd) return asd.localeCompare(bsd);
    return Number(al) - Number(bl);
  });
  for (const [key, arr] of sorted) {
    const [sym, side, lvl] = key.split("|");
    const wins = arr.filter((s) => s.pnl > 0).length;
    const losses = arr.filter((s) => s.pnl < 0).length;
    const net = arr.reduce((s, x) => s + x.pnl, 0);
    const wr = arr.length > 0 ? wins / arr.length : 0;
    const epd = arr.length > 0 ? net / arr.length : 0;
    const stkAvg = arr.reduce((s, x) => s + x.stake, 0) / arr.length;
    const lvlStr = lvl === "-1" ? "—" : lvl === "-2" ? "?" : `L${lvl}`;
    console.log(`  ${sym.padEnd(10)}  ${side.padEnd(4)}  ${lvlStr.padStart(3)}  $${stkAvg.toFixed(2).padStart(6)}   ${String(arr.length).padStart(4)}t   ${String(wins).padStart(3)} ${String(losses).padStart(3)}   ${(wr*100).toFixed(1).padStart(4)}%  ${net >= 0 ? "+" : ""}$${net.toFixed(2).padStart(7)}      ${epd >= 0 ? "+" : ""}$${epd.toFixed(3)}`);
  }

  // Loss distribution: top 10 worst trades
  const losers = settled.filter((s) => s.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 10);
  console.log(`\nTOP 10 BIGGEST LOSSES:`);
  console.log(`  ts                   sym         side  stake     pnl       lvl`);
  for (const l of losers) {
    const ts = new Date(l.ts * 1000).toISOString().slice(5, 16).replace("T", " ");
    const lvlStr = l.lvl === -1 ? "—" : l.lvl === -2 ? "?" : `L${l.lvl}`;
    console.log(`  ${ts}        ${l.sym.padEnd(10)}  ${l.side.padEnd(4)}  $${l.stake.toFixed(2).padStart(6)}   $${l.pnl.toFixed(2).padStart(7)}   ${lvlStr}`);
  }

  // Per-symbol per-side ladder LOSS concentration
  console.log(`\nLOSS-$ CONCENTRATION (where the money went):`);
  for (const sym of SYMBOLS_OF_INTEREST) {
    for (const side of ["BUY", "SELL"]) {
      const all = settled.filter((s) => s.sym === sym && s.side === side);
      if (all.length === 0) continue;
      const totalLoss = all.filter((s) => s.pnl < 0).reduce((s, x) => s + x.pnl, 0);
      const totalWin = all.filter((s) => s.pnl > 0).reduce((s, x) => s + x.pnl, 0);
      console.log(`\n  ${sym} ${side}:  losses=$${totalLoss.toFixed(2)}  wins=+$${totalWin.toFixed(2)}  net=${totalLoss + totalWin >= 0 ? "+" : ""}$${(totalLoss + totalWin).toFixed(2)}`);
      const byLvl = new Map<number, { trades: number; wins: number; losses: number; netLoss: number; netWin: number }>();
      for (const t of all) {
        if (!byLvl.has(t.lvl)) byLvl.set(t.lvl, { trades: 0, wins: 0, losses: 0, netLoss: 0, netWin: 0 });
        const e = byLvl.get(t.lvl)!;
        e.trades++;
        if (t.pnl > 0) { e.wins++; e.netWin += t.pnl; } else { e.losses++; e.netLoss += t.pnl; }
      }
      const lvlEntries = [...byLvl.entries()].sort((a, b) => a[0] - b[0]);
      for (const [lvl, e] of lvlEntries) {
        const lvlStr = lvl === -1 ? "—" : lvl === -2 ? "?" : `L${lvl}`;
        const net = e.netLoss + e.netWin;
        console.log(`    ${lvlStr.padStart(3)}  ${e.trades.toString().padStart(3)}t  ${e.wins.toString().padStart(3)}W ${e.losses.toString().padStart(3)}L  losses=$${e.netLoss.toFixed(2).padStart(7)}  wins=+$${e.netWin.toFixed(2).padStart(6)}  net=${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
