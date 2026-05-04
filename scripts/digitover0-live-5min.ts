// LIVE 5-minute test of DIGITOVER 0 on R_25/R_50/R_75 via Deriv API.
// Subscribes to ticks, places a real DIGITODD…wait, DIGITOVER barrier=0
// contract on each new tick (paced to stay under rate limits), tracks
// win/loss, prints summary at the end.
//
// Stake: $1 per contract (Deriv DIGIT minimum). No martingale.
// Three symbols × ~3 ticks/sec staggered = ~ 80-150 trades total.
//
// Usage: DERIV_TOKEN=<token> npx ts-node scripts/digitover0-live-5min.ts

const APP_ID = "1089";
const WS_URL = `wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`;
const TOKEN = process.env.DERIV_TOKEN;
if (!TOKEN) { console.error("Set DERIV_TOKEN env var"); process.exit(1); }

const SYMBOLS = ["R_25", "R_50", "R_75"];
const STAKE = 1;
const DURATION_MS = 5 * 60_000;          // 5 min
const GLOBAL_MIN_GAP_MS = 2000;          // ~30 buys/min total — under Deriv 80/min pricing budget
const PER_SYMBOL_GAP_MS = 4000;          // ~15 buys/min per symbol

class C {
  ws: any; reqId = 1;
  pending = new Map<number, { resolve: (m: any) => void; reject: (e: Error) => void }>();
  ready!: Promise<void>;
  closed = false;
  constructor() {
    const WS = require("ws");
    this.ws = new WS(WS_URL);
    this.ready = new Promise((res) => this.ws.on("open", () => res()));
    this.ws.on("message", (raw: any) => this.onMsg(String(raw)));
    this.ws.on("close", () => { this.closed = true; });
  }
  private listeners: ((m: any) => void)[] = [];
  onMessage(cb: (m: any) => void) { this.listeners.push(cb); }
  private onMsg(raw: string) {
    try {
      const m = JSON.parse(raw);
      const id = m.req_id;
      if (id != null && this.pending.has(id)) {
        const { resolve, reject } = this.pending.get(id)!;
        this.pending.delete(id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m);
        return;
      }
      for (const cb of this.listeners) cb(m);
    } catch {}
  }
  send(req: any): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = this.reqId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ ...req, req_id: id }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error("timeout")); } }, 30_000);
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

type Trade = { sym: string; contractId: number; stake: number; buyPrice: number; entryDigit: number; settled: boolean; sellPrice?: number; profit?: number };
const trades = new Map<number, Trade>();
let bets = 0, wins = 0, losses = 0, netPnl = 0;
const startBalance = { val: 0 };
const lastBuyAtSym = new Map<string, number>();
let lastBuyAtGlobal = 0;
const inFlight = new Set<string>();

function lastDigit(price: number): number {
  const s = price.toString();
  const dot = s.indexOf(".");
  if (dot < 0) return 0;
  const dec = s.slice(dot + 1);
  return dec.length > 0 ? Number(dec[dec.length - 1]) : 0;
}

async function main() {
  const c = new C(); await c.ready;
  const auth = await c.send({ authorize: TOKEN });
  console.log(`Authorized: ${auth.authorize.loginid}  bal=$${auth.authorize.balance}`);
  startBalance.val = auth.authorize.balance;

  // Listen for contract settlement updates
  c.onMessage((m: any) => {
    if (m.msg_type === "proposal_open_contract") {
      const info = m.proposal_open_contract;
      if (!info) return;
      const id = info.contract_id;
      const t = trades.get(id);
      if (!t) return;
      if (info.is_sold === 1 || info.status === "won" || info.status === "lost") {
        if (t.settled) return;
        t.settled = true;
        t.sellPrice = info.sell_price ?? 0;
        t.profit = (t.sellPrice ?? 0) - t.buyPrice;
        if ((t.profit ?? 0) > 0) wins++; else losses++;
        netPnl += t.profit ?? 0;
        const tag = (t.profit ?? 0) > 0 ? "WIN " : "LOSS";
        const time = new Date().toISOString().slice(11, 19);
        console.log(`[${time}] ${tag} ${t.sym} entryDigit=${t.entryDigit} exitDigit=${info.exit_tick != null ? lastDigit(Number(info.exit_tick)) : "?"} pnl=${(t.profit ?? 0) >= 0 ? "+" : ""}$${(t.profit ?? 0).toFixed(2)} cumNet=${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}  W=${wins} L=${losses}`);
      }
    } else if (m.msg_type === "tick") {
      onTick(c, m.tick);
    }
  });

  // Subscribe to ticks for all 3 symbols
  for (const sym of SYMBOLS) {
    await c.send({ ticks: sym, subscribe: 1 });
    console.log(`subscribed ticks: ${sym}`);
  }

  console.log(`\n→ trading DIGITOVER 0 on R_25/R_50/R_75 for ${DURATION_MS / 60_000} min · stake $${STAKE} · gap ${GLOBAL_MIN_GAP_MS}ms global / ${PER_SYMBOL_GAP_MS}ms per-symbol\n`);

  // Run for DURATION_MS
  await new Promise((r) => setTimeout(r, DURATION_MS));

  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`5-min test complete. Waiting 10s for last settlements...`);
  await new Promise((r) => setTimeout(r, 10_000));

  // Final summary
  const wr = bets > 0 ? wins / bets : 0;
  const settledCount = wins + losses;
  console.log(`\n${"".padEnd(80, "═")}`);
  console.log(`RESULTS — DIGITOVER 0 LIVE 5-min test`);
  console.log(`${"".padEnd(80, "═")}`);
  console.log(`  Bets placed:    ${bets}`);
  console.log(`  Settled:        ${settledCount}  (still pending: ${bets - settledCount})`);
  console.log(`  Wins / Losses:  ${wins} / ${losses}  (WR ${(wr * 100).toFixed(2)}%)`);
  console.log(`  Net P&L:        ${netPnl >= 0 ? "+" : ""}$${netPnl.toFixed(2)}`);
  console.log(`  Avg / trade:    $${settledCount > 0 ? (netPnl / settledCount).toFixed(4) : "—"}`);

  // Per-symbol breakdown
  const bySym = new Map<string, { bets: number; wins: number; losses: number; pnl: number }>();
  for (const t of Array.from(trades.values())) {
    if (!t.settled) continue;
    const s = bySym.get(t.sym) ?? { bets: 0, wins: 0, losses: 0, pnl: 0 };
    s.bets++;
    if ((t.profit ?? 0) > 0) s.wins++; else s.losses++;
    s.pnl += t.profit ?? 0;
    bySym.set(t.sym, s);
  }
  console.log(`\nPer-symbol:`);
  console.log(`  ${"sym".padEnd(8)} bets  W   L    WR        net`);
  for (const sym of SYMBOLS) {
    const s = bySym.get(sym);
    if (!s) { console.log(`  ${sym.padEnd(8)} 0     —`); continue; }
    const swr = s.bets > 0 ? s.wins / s.bets * 100 : 0;
    console.log(`  ${sym.padEnd(8)} ${String(s.bets).padStart(4)}  ${String(s.wins).padStart(3)} ${String(s.losses).padStart(3)}   ${swr.toFixed(2).padStart(6)}%   ${s.pnl >= 0 ? "+" : ""}$${s.pnl.toFixed(2)}`);
  }

  // Final balance check
  try {
    const bal = await c.send({ balance: 1 });
    const finalBal = bal.balance?.balance ?? 0;
    const delta = finalBal - startBalance.val;
    console.log(`\nDeriv balance: $${startBalance.val} → $${finalBal}  (Δ ${delta >= 0 ? "+" : ""}$${delta.toFixed(2)})`);
  } catch {}

  c.close();
}

async function onTick(c: C, tick: { symbol: string; epoch: number; quote: number }) {
  const now = Date.now();
  if (!SYMBOLS.includes(tick.symbol)) return;
  if (inFlight.has(tick.symbol)) return;
  if (now - lastBuyAtGlobal < GLOBAL_MIN_GAP_MS) return;
  const lastSym = lastBuyAtSym.get(tick.symbol) ?? 0;
  if (now - lastSym < PER_SYMBOL_GAP_MS) return;

  inFlight.add(tick.symbol);
  lastBuyAtSym.set(tick.symbol, now);
  lastBuyAtGlobal = now;
  const entryDigit = lastDigit(tick.quote);

  try {
    const prop = await c.send({
      proposal: 1,
      amount: STAKE,
      basis: "stake",
      contract_type: "DIGITOVER",
      currency: "USD",
      duration: 1,
      duration_unit: "t",
      symbol: tick.symbol,
      barrier: "0",
    });
    const p = prop.proposal;
    if (!p) throw new Error("no proposal");
    const buyResp = await c.send({ buy: p.id, price: p.ask_price });
    const buy = buyResp.buy;
    if (!buy) throw new Error("no buy");
    bets++;
    trades.set(buy.contract_id, {
      sym: tick.symbol,
      contractId: buy.contract_id,
      stake: STAKE,
      buyPrice: buy.buy_price,
      entryDigit,
      settled: false,
    });
    // Subscribe to settle stream
    await c.send({ proposal_open_contract: 1, contract_id: buy.contract_id, subscribe: 1 });
    const time = new Date().toISOString().slice(11, 19);
    console.log(`[${time}] BUY  ${tick.symbol} entryDigit=${entryDigit} stake=$${STAKE} contract=${buy.contract_id} payout=${p.payout}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (msg.includes("RateLimit") || msg.includes("rate limit")) {
      console.log(`[ratelimit] ${tick.symbol} — skip`);
    } else {
      console.log(`[err] ${tick.symbol}: ${msg}`);
    }
  } finally {
    inFlight.delete(tick.symbol);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
