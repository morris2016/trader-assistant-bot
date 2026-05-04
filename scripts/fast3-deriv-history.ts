// Pull historical fast3 DIGITODD performance per symbol from Deriv's
// profit_table. Independent of bot state — gives ground truth on which
// of the 8 fast3 strategies actually performed before some were disabled.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/fast3-deriv-history.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

// Optional: limit to last N hours via env (default = all available history).
const SINCE_HOURS = Number(process.env.SINCE_HOURS ?? 0);

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
        const m = JSON.parse(String(raw));
        const id = m.req_id;
        if (id != null && this.pending.has(id)) {
          const { resolve, reject } = this.pending.get(id)!;
          this.pending.delete(id);
          if (m.error) reject(new Error(m.error.message)); else resolve(m);
        }
      } catch {}
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
  close() { try { this.ws.close(); } catch {} }
}

type Stat = { trades: number; wins: number; losses: number; net: number; firstTs: number; lastTs: number };
function newStat(): Stat { return { trades: 0, wins: 0, losses: 0, net: 0, firstTs: 0, lastTs: 0 }; }

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  console.log(`Authorized: ${auth.authorize.loginid} bal=$${auth.authorize.balance}`);

  // profit_table: paginate. shortcode encodes contract type + symbol.
  // For DIGITODD on R_50 the shortcode looks like: "DIGITODD_R_50_2.00_..."
  const sinceEpoch = SINCE_HOURS > 0 ? Math.floor(Date.now() / 1000) - SINCE_HOURS * 3600 : 0;
  console.log(`Pulling profit_table${sinceEpoch ? ` since ${new Date(sinceEpoch*1000).toISOString()}` : " (all history)"}`);

  const PAGE = 100;
  let offset = 0;
  let total = 0;
  let page = 0;
  const stats = new Map<string, Stat>();

  while (true) {
    const r = await c.send({ profit_table: 1, limit: PAGE, offset, description: 1, sort: "DESC" });
    const rows = (r.profit_table?.transactions ?? []) as any[];
    if (rows.length === 0) break;
    page++;
    for (const t of rows) {
      const sc = String(t.shortcode ?? "");
      if (!sc.startsWith("DIGITODD_") && !sc.startsWith("DIGITEVEN_")) continue;
      const purchaseEpoch = Number(t.purchase_time ?? 0);
      if (sinceEpoch && purchaseEpoch < sinceEpoch) { offset = -1; break; }
      // shortcode format: "DIGITODD_<SYMBOL>_<stake>_<purchase_time>_<...>"
      // Symbols like R_50 / R_100 contain a literal underscore. The naive
      // "first underscore" split would yield "R", so we anchor on the
      // STAKE token: a decimal-with-fractional like 2.00 or 1.50. Symbol =
      // everything between the contract type prefix and that token.
      const inner = sc.replace(/^DIGITODD_|^DIGITEVEN_/, "");
      const m = inner.match(/^(.+?)_(\d+\.\d+)_\d+_/);
      const symbol = m ? m[1] : inner.split("_")[0];
      const stake = Number(t.buy_price ?? 0);
      const sellPrice = Number(t.sell_price ?? 0);
      const pnl = +(sellPrice - stake).toFixed(2);
      const s = stats.get(symbol) ?? newStat();
      s.trades++;
      if (pnl > 0) s.wins++; else s.losses++;
      s.net = +(s.net + pnl).toFixed(2);
      if (s.firstTs === 0 || purchaseEpoch < s.firstTs) s.firstTs = purchaseEpoch;
      if (purchaseEpoch > s.lastTs) s.lastTs = purchaseEpoch;
      stats.set(symbol, s);
      total++;
    }
    if (offset === -1) break;
    process.stdout.write(`\rpage ${page}: collected ${total} DIGIT trades from ${rows.length} rows...`);
    if (rows.length < PAGE) break;
    offset += PAGE;
    if (page > 100) break; // safety cap
  }
  console.log();
  c.close();

  if (stats.size === 0) {
    console.log(`No DIGITODD/EVEN trades found in profit_table.`);
    return;
  }

  // Print per-symbol breakdown sorted by net P&L.
  const rows = Array.from(stats.entries()).map(([sym, s]) => ({
    sym,
    ...s,
    wr: s.trades > 0 ? s.wins / s.trades : 0,
    spanHrs: (s.lastTs - s.firstTs) / 3600,
  }));
  rows.sort((a, b) => b.net - a.net);

  console.log(`\n${"".padEnd(110, "═")}`);
  console.log(`Per-symbol DIGITODD/EVEN performance (sorted by $ net):`);
  console.log(`${"".padEnd(110, "═")}`);
  console.log(`${"symbol".padEnd(10)} ${"trades".padStart(7)} ${"W".padStart(4)} ${"L".padStart(4)}  ${"WR".padStart(6)}  ${"net".padStart(10)}  ${"avg/trade".padStart(11)}  span (hrs)  first → last`);
  for (const r of rows) {
    const avg = r.trades > 0 ? r.net / r.trades : 0;
    const first = new Date(r.firstTs * 1000).toISOString().slice(5, 16).replace("T", " ");
    const last = new Date(r.lastTs * 1000).toISOString().slice(5, 16).replace("T", " ");
    console.log(`${r.sym.padEnd(10)} ${String(r.trades).padStart(7)} ${String(r.wins).padStart(4)} ${String(r.losses).padStart(4)}  ${(r.wr * 100).toFixed(1).padStart(5)}%  ${(r.net >= 0 ? "+" : "") + "$" + r.net.toFixed(2).padStart(9)}  ${(avg >= 0 ? "+" : "") + "$" + avg.toFixed(3).padStart(8)}  ${r.spanHrs.toFixed(1).padStart(8)}h  ${first} → ${last}`);
  }
  const totals = rows.reduce((acc, r) => ({ trades: acc.trades + r.trades, wins: acc.wins + r.wins, net: acc.net + r.net }), { trades: 0, wins: 0, net: 0 });
  const totalWR = totals.trades > 0 ? totals.wins / totals.trades : 0;
  console.log(`${"".padEnd(110, "─")}`);
  console.log(`${"TOTAL".padEnd(10)} ${String(totals.trades).padStart(7)} ${String(totals.wins).padStart(4)} ${String(totals.trades - totals.wins).padStart(4)}  ${(totalWR * 100).toFixed(1).padStart(5)}%  ${(totals.net >= 0 ? "+" : "") + "$" + totals.net.toFixed(2).padStart(9)}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
