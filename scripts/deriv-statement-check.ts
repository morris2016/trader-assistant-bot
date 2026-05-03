// Deriv real-account statement checker — pulls profit_table for the
// authenticated account, filters BOOM/CRASH 300N + RDBEAR, reports actual
// live performance by symbol/side. Compare against backtest expectations.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/deriv-statement-check.ts

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
  contract_type?: string;
  shortcode?: string;
  symbol?: string;
  buy_price: number;
  sell_price: number;
  payout?: number;
  purchase_time: number;
  sell_time: number;
  longcode?: string;
};

function extractSymbolAndSide(longcode: string, shortcode: string): { sym: string; side: string } {
  // Multiplier longcode looks like:
  //   "If you select Up, your payout will be ... CRASH 300 Index..."
  //   "Long" / "Up" / contract_type "MULTUP" = BUY
  //   "Short" / "Down" / "MULTDOWN" = SELL
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
  const sc = (shortcode || "");
  if (sc.startsWith("MULTUP_") || sc.includes("_MULTUP_")) side = "BUY";
  else if (sc.startsWith("MULTDOWN_") || sc.includes("_MULTDOWN_")) side = "SELL";
  else if (longcode.toLowerCase().includes("long") || longcode.toLowerCase().includes(" up ")) side = "BUY";
  else if (longcode.toLowerCase().includes("short") || longcode.toLowerCase().includes(" down ")) side = "SELL";
  return { sym, side };
}

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  const acct = auth.authorize?.loginid ?? "?";
  const cur = auth.authorize?.currency ?? "?";
  const bal = auth.authorize?.balance ?? "?";
  console.log(`Authorized as ${acct} (${cur}, balance=${bal})`);
  console.log(`Pulling profit_table for last 1000 contracts...\n`);

  // Pull up to 1000 most-recent settled contracts (paginate by offset)
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

  console.log(`Fetched ${allRows.length} settled contracts.\n`);

  // Filter to symbols of interest and classify
  type Settled = { sym: string; side: string; pnl: number; ts: string; contract_id: number };
  const settled: Settled[] = [];
  for (const row of allRows) {
    const lc = row.longcode ?? "";
    const sc = row.shortcode ?? "";
    const { sym, side } = extractSymbolAndSide(lc, sc);
    if (!sym) continue;
    const pnl = (row.sell_price ?? 0) - (row.buy_price ?? 0);
    settled.push({
      sym,
      side,
      pnl,
      ts: new Date(row.sell_time * 1000).toISOString(),
      contract_id: row.contract_id,
    });
  }

  if (settled.length === 0) {
    console.log("No BOOM/CRASH 300N or RDBEAR contracts found in last 1000 settled.");
    return;
  }

  // Group: per (sym, side)
  const groups = new Map<string, Settled[]>();
  for (const s of settled) {
    const key = `${s.sym}|${s.side}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }

  console.log(`${"".padEnd(80, "═")}`);
  console.log(`PER (symbol, side) BREAKDOWN — actual live results`);
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`  symbol      side   trades   W   L   WR     net          per-trade`);
  for (const [key, arr] of [...groups.entries()].sort()) {
    const [sym, side] = key.split("|");
    const wins = arr.filter((s) => s.pnl > 0).length;
    const losses = arr.filter((s) => s.pnl < 0).length;
    const breakeven = arr.length - wins - losses;
    const net = arr.reduce((s, x) => s + x.pnl, 0);
    const wr = arr.length > 0 ? wins / arr.length : 0;
    const epd = arr.length > 0 ? net / arr.length : 0;
    const breakStr = breakeven > 0 ? ` (${breakeven} b/e)` : "";
    console.log(`  ${sym.padEnd(10)}  ${side.padEnd(4)}  ${String(arr.length).padStart(4)}t    ${String(wins).padStart(3)} ${String(losses).padStart(3)}   ${(wr*100).toFixed(1).padStart(4)}%  ${net >= 0 ? "+" : ""}$${net.toFixed(2).padStart(7)}      ${epd >= 0 ? "+" : ""}$${epd.toFixed(3)}${breakStr}`);
  }

  // Per-symbol totals
  console.log(`\nPER-SYMBOL TOTALS:`);
  const bySym = new Map<string, Settled[]>();
  for (const s of settled) {
    if (!bySym.has(s.sym)) bySym.set(s.sym, []);
    bySym.get(s.sym)!.push(s);
  }
  for (const [sym, arr] of bySym) {
    const wins = arr.filter((s) => s.pnl > 0).length;
    const net = arr.reduce((s, x) => s + x.pnl, 0);
    const wr = arr.length > 0 ? wins / arr.length : 0;
    console.log(`  ${sym.padEnd(10)}  ${arr.length}t  WR=${(wr*100).toFixed(1)}%  net=${net >= 0 ? "+" : ""}$${net.toFixed(2)}`);
  }

  // Date range
  if (settled.length > 0) {
    const tsList = settled.map((s) => s.ts).sort();
    console.log(`\nDate range: ${tsList[0].slice(0, 16)} → ${tsList[tsList.length - 1].slice(0, 16)}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
