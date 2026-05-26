// Replay TODAY (2026-05-26) with strength-filtered + dynamically-sized rules.
// Strength quintile breakpoints derived from TRAIN window (2025-05-26→2025-12-31).
//
// Run: npx tsx scripts/hf-screen/trade-today-filtered.ts

import * as fs from "fs";
import {
  ASSETS, COST_RT,
  TRAIL_ARM_ATR, TRAIL_RETRACE_ATR, HARD_TIMEOUT_MIN, HARD_SL_ATR,
  load1m, roll, atr as atrFn, ema as emaFn,
  alignTo1h, buildMinuteIdx,
  RESULTS_DIR,
  type Bar,
} from "./lib";

const PER_ASSET_MAX_LEV: Record<string, number> = {
  BTCUSDT: 125, ETHUSDT: 125,
  SOLUSDT: 75, BNBUSDT: 75, XRPUSDT: 75, DOGEUSDT: 75, AVAXUSDT: 75, ADAUSDT: 75, LINKUSDT: 75, DOTUSDT: 75, BCHUSDT: 75,
  LDOUSDT: 50, AAVEUSDT: 50, UNIUSDT: 50, POLUSDT: 50,
};
// Default = today (May 26 UTC). Override via DAY env (e.g. DAY=2026-05-25).
// Optional DAYS env multiplies window backwards from DAY (e.g. DAY=2026-05-26 DAYS=7).
const DAY_STR = process.env.DAY ?? "2026-05-26";
const DAYS = +(process.env.DAYS ?? "1");
const TODAY_END = Math.floor(new Date(`${DAY_STR}T00:00:00Z`).getTime() / 1000) + 86400;
const TODAY_START = TODAY_END - DAYS * 86400;
const TRAIN_FROM = Math.floor(new Date("2025-05-26T00:00:00Z").getTime() / 1000);
const TRAIN_TO   = Math.floor(new Date("2025-12-31T23:59:59Z").getTime() / 1000);
const START_WALLET = 100;

const cv = JSON.parse(fs.readFileSync(`${RESULTS_DIR}/factor-mine-cv.json`, "utf8"));
const Q = cv.trainQuintiles as Record<string, number[]>;

function bucketOf(v: number, breaks: number[]): number {
  let b = 0; for (const t of breaks) if (v >= t) b++; return b;
}

type Side = "LONG" | "SHORT";
const RULES = [
  {
    id: "M1",
    name: "Buy deep dip in 1h uptrend",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 4 && bucketOf(f.z100, Q.z100) === 0 ? "LONG" : null,
    strength: (f: any) => Math.max(0, -1.29 - f.z100) + Math.max(0, f.htf4hRet) * 10,
  },
  {
    id: "M2",
    name: "Short reverts in downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z100, Q.z100) === 2 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
  {
    id: "M3",
    name: "Fade rally in weak downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 1 && bucketOf(f.z100, Q.z100) === 3 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 0.46) + Math.max(0, -0.0059 - f.htf4hRet) * 10,
  },
  {
    id: "M4",
    name: "Fade rally when 1h trend down",
    check: (f: any): Side | null => bucketOf(f.htf1hTrend, Q.htf1hTrend) === 2 && bucketOf(f.z100, Q.z100) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z100 - 1.29),
  },
  {
    id: "M5",
    name: "Fade extended bounce in downtrend",
    check: (f: any): Side | null => bucketOf(f.htf4hRet, Q.htf4hRet) === 0 && bucketOf(f.z50, Q.z50) === 4 ? "SHORT" : null,
    strength: (f: any) => Math.max(0, f.z50 - 1.28) + Math.max(0, -0.0235 - f.htf4hRet) * 10,
  },
];
const SCHEDULE: Record<string, Array<number | undefined>> = {
  M1: [undefined, undefined, 20, 25, 30],
  M2: [25, 25, 25, 25, undefined],
  M3: [undefined, undefined, 20, 25, 30],
  M4: [undefined, undefined, 20, 25, 30],
  M5: [20, 20, undefined, undefined, undefined],
};

type Signal = {
  asset: string; ruleId: string; side: Side;
  nextBarEpoch: number; nextOpenPrice: number; atr: number;
  strength: number; qstr: number; stake: number | undefined;
  factors: any;
};

async function main() {
  const startStr = new Date(TODAY_START * 1000).toISOString().slice(0, 10);
  const endStr = new Date((TODAY_END - 1) * 1000).toISOString().slice(0, 10);
  console.log(`\n══ Trading window ${startStr} → ${endStr} UTC (${DAYS}d) — filtered + dynamically-sized ══\n`);

  // ── 1. Load all data ───────────────────────────────────────────────────
  const assetData = new Map<string, { bars1m: Bar[]; minMap: Map<number, number>; signals: Signal[] }>();
  for (const sym of ASSETS) {
    process.stdout.write(`  ${sym.padEnd(10)} `);
    const bars1m = load1m(sym, TRAIN_FROM - 30 * 86400, TODAY_END);
    if (bars1m.length === 0) { console.log("no data"); continue; }
    const minMap = buildMinuteIdx(bars1m);
    const bars15m = roll(bars1m, 900);
    const bars1h = roll(bars1m, 3600);
    const closes15m = bars15m.map(b => b.close);
    const closes1h = bars1h.map(b => b.close);
    const atrArr = new Float64Array(bars15m.length);
    const ema50_1hArr = new Float64Array(bars1h.length);
    for (let i = 0; i < bars15m.length; i++) atrArr[i] = atrFn(bars15m, 14, i);
    for (let i = 0; i < bars1h.length; i++) ema50_1hArr[i] = emaFn(closes1h, 50, i);

    const signals: Signal[] = [];
    for (let i = 100; i < bars15m.length - 1; i++) {
      const b = bars15m[i];
      if (!isFinite(atrArr[i]) || atrArr[i] <= 0) continue;
      const i1h = alignTo1h(bars1h, b.epoch);
      if (i1h < 50) continue;
      const zN = (n: number) => {
        let s = 0;
        for (let j = i - n + 1; j <= i; j++) s += closes15m[j];
        const m = s / n;
        let v = 0;
        for (let j = i - n + 1; j <= i; j++) v += (closes15m[j] - m) ** 2;
        const sd = Math.sqrt(v / n);
        return sd === 0 ? 0 : (closes15m[i] - m) / sd;
      };
      const f = {
        z50: zN(50), z100: zN(100),
        htf1hTrend: isFinite(ema50_1hArr[i1h]) ? (closes1h[i1h] > ema50_1hArr[i1h] ? 1 : 0) : 0.5,
        htf4hRet: (closes1h[i1h] - closes1h[Math.max(0, i1h - 16)]) / closes1h[Math.max(0, i1h - 16)],
      };
      for (const rule of RULES) {
        const side = rule.check(f);
        if (!side) continue;
        const next = bars15m[i + 1];
        signals.push({
          asset: sym, ruleId: rule.id, side,
          nextBarEpoch: next.epoch, nextOpenPrice: next.open, atr: atrArr[i],
          strength: rule.strength(f), qstr: -1, stake: undefined,
          factors: { ...f },
        });
      }
    }
    assetData.set(sym, { bars1m, minMap, signals });
    console.log(`${signals.length} signals`);
  }

  // ── 2. Compute TRAIN-only strength quintile breakpoints per rule ───────
  const breaks: Record<string, number[]> = {};
  for (const r of RULES) {
    const ss: number[] = [];
    for (const d of assetData.values()) for (const s of d.signals) if (s.ruleId === r.id && s.nextBarEpoch >= TRAIN_FROM && s.nextBarEpoch <= TRAIN_TO) ss.push(s.strength);
    ss.sort((a, b) => a - b);
    if (ss.length === 0) continue;
    breaks[r.id] = [ss[Math.floor(ss.length * 0.2)], ss[Math.floor(ss.length * 0.4)], ss[Math.floor(ss.length * 0.6)], ss[Math.floor(ss.length * 0.8)]];
  }

  // ── 3. Filter today's signals, attach quintile + stake ─────────────────
  const todaySigs: Signal[] = [];
  for (const d of assetData.values()) {
    for (const s of d.signals) {
      if (s.nextBarEpoch < TODAY_START || s.nextBarEpoch >= TODAY_END) continue;
      const b = breaks[s.ruleId];
      if (!b) continue;
      let q = 0; for (const t of b) if (s.strength >= t) q++;
      s.qstr = q;
      const st = SCHEDULE[s.ruleId][q];
      s.stake = st;
      todaySigs.push(s);
    }
  }
  todaySigs.sort((a, b) => a.nextBarEpoch - b.nextBarEpoch);

  console.log(`\nTotal signals fired today: ${todaySigs.length}`);
  const passed = todaySigs.filter(s => s.stake !== undefined);
  console.log(`After strength filter:    ${passed.length} (${todaySigs.length - passed.length} dropped by filter)`);
  if (passed.length === 0) {
    console.log(`\nNo qualifying signals today — capital preserved.`);
    return;
  }

  // ── 4. Wallet sim ──────────────────────────────────────────────────────
  let wallet = START_WALLET, locked = 0;
  type OpenPos = { ruleId: string; asset: string; side: Side; entry: number; atr: number; lev: number; openEpoch: number; stake: number; peakFav: number; armed: boolean; strength: number; qstr: number };
  const open: OpenPos[] = [];
  type Trade = { ruleId: string; asset: string; side: Side; qstr: number; stake: number; lev: number; entry: number; exit: number; pnl: number; openTs: string; closeTs: string; reason: string };
  const trades: Trade[] = [];

  // Build minute timeline
  const epochSet = new Set<number>();
  for (const d of assetData.values()) for (const b of d.bars1m) if (b.epoch >= TODAY_START && b.epoch < TODAY_END + HARD_TIMEOUT_MIN * 60) epochSet.add(b.epoch);
  const sortedE = Array.from(epochSet).sort((a, b) => a - b);
  const sigByEp = new Map<number, Signal[]>();
  for (const s of passed) {
    if (!sigByEp.has(s.nextBarEpoch)) sigByEp.set(s.nextBarEpoch, []);
    sigByEp.get(s.nextBarEpoch)!.push(s);
  }

  for (const e of sortedE) {
    // Process closes
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      const data = assetData.get(pos.asset)!;
      const idx = data.minMap.get(e); if (idx === undefined) continue;
      const bar = data.bars1m[idx];
      const armD = TRAIL_ARM_ATR * pos.atr, trD = TRAIL_RETRACE_ATR * pos.atr, slD = HARD_SL_ATR * pos.atr;
      const slPx = pos.side === "LONG" ? pos.entry - slD : pos.entry + slD;
      let closed = false, exitPx = 0, reason = "";
      if (e >= pos.openEpoch + HARD_TIMEOUT_MIN * 60) { exitPx = bar.close; closed = true; reason = "timeout"; }
      else if (pos.side === "LONG") {
        if (bar.low <= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.high > pos.peakFav) pos.peakFav = bar.high;
          if (!pos.armed && pos.peakFav >= pos.entry + armD) pos.armed = true;
          if (pos.armed && bar.low <= pos.peakFav - trD) { exitPx = pos.peakFav - trD; closed = true; reason = "trail"; }
        }
      } else {
        if (bar.high >= slPx) { exitPx = slPx; closed = true; reason = "SL"; }
        else {
          if (bar.low < pos.peakFav) pos.peakFav = bar.low;
          if (!pos.armed && pos.peakFav <= pos.entry - armD) pos.armed = true;
          if (pos.armed && bar.high >= pos.peakFav + trD) { exitPx = pos.peakFav + trD; closed = true; reason = "trail"; }
        }
      }
      if (closed) {
        const gross = pos.side === "LONG" ? (exitPx - pos.entry) / pos.entry : (pos.entry - exitPx) / pos.entry;
        const pnl = pos.stake * pos.lev * (gross - COST_RT);
        wallet += pos.stake + pnl; locked -= pos.stake;
        trades.push({
          ruleId: pos.ruleId, asset: pos.asset, side: pos.side, qstr: pos.qstr, stake: pos.stake, lev: pos.lev,
          entry: pos.entry, exit: exitPx, pnl,
          openTs: new Date(pos.openEpoch * 1000).toISOString().slice(11, 16),
          closeTs: new Date(e * 1000).toISOString().slice(11, 16),
          reason,
        });
        open.splice(i, 1);
      }
    }
    // Process opens
    const sigs = sigByEp.get(e);
    if (sigs) for (const sig of sigs) {
      if (wallet < sig.stake!) continue;
      if (open.some(p => p.asset === sig.asset && p.side === sig.side)) continue;
      const lev = PER_ASSET_MAX_LEV[sig.asset] ?? 75;
      open.push({
        ruleId: sig.ruleId, asset: sig.asset, side: sig.side,
        entry: sig.nextOpenPrice, atr: sig.atr, lev, openEpoch: sig.nextBarEpoch,
        stake: sig.stake!, peakFav: sig.nextOpenPrice, armed: false,
        strength: sig.strength, qstr: sig.qstr,
      });
      wallet -= sig.stake!; locked += sig.stake!;
    }
  }

  // ── 5. Report ──────────────────────────────────────────────────────────
  console.log(`\nWallet start: $${START_WALLET}`);
  console.log(`Wallet now:   $${(wallet + locked).toFixed(2)}  (cash $${wallet.toFixed(2)}, margin in open $${locked.toFixed(2)})`);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const wins = trades.filter(t => t.pnl > 0).length;
  console.log(`Closed trades: ${trades.length}  Wins: ${wins}  WR: ${trades.length ? (wins / trades.length * 100).toFixed(1) : 0}%`);
  console.log(`Net P&L: ${totalPnl >= 0 ? "+" : ""}$${totalPnl.toFixed(2)}`);
  console.log(`Open positions: ${open.length}`);

  console.log(`\nPer-rule:`);
  for (const r of RULES) {
    const ts = trades.filter(t => t.ruleId === r.id);
    if (ts.length === 0) { console.log(`  ${r.id}  0 trades  (${r.name})`); continue; }
    const w = ts.filter(t => t.pnl > 0).length;
    const net = ts.reduce((s, t) => s + t.pnl, 0);
    console.log(`  ${r.id}  n=${String(ts.length).padStart(2)}  WR=${(w / ts.length * 100).toFixed(0).padStart(3)}%  net=${net >= 0 ? "+" : ""}$${net.toFixed(2).padStart(7)}  (${r.name})`);
  }

  console.log(`\nPer-asset:`);
  const byA: Record<string, { n: number; w: number; net: number }> = {};
  for (const t of trades) {
    if (!byA[t.asset]) byA[t.asset] = { n: 0, w: 0, net: 0 };
    byA[t.asset].n++; if (t.pnl > 0) byA[t.asset].w++;
    byA[t.asset].net += t.pnl;
  }
  for (const [a, s] of Object.entries(byA).sort((a, b) => b[1].net - a[1].net)) {
    console.log(`  ${a.padEnd(10)} n=${String(s.n).padStart(2)}  WR=${(s.w / s.n * 100).toFixed(0).padStart(3)}%  net=${s.net >= 0 ? "+" : ""}$${s.net.toFixed(2).padStart(6)}`);
  }

  console.log(`\nAll trades chronological:`);
  for (const t of trades) {
    const tag = t.pnl > 0 ? "✓" : "✗";
    console.log(`  ${t.openTs}→${t.closeTs}  ${t.asset.padEnd(10)} ${t.side.padEnd(5)} ${t.ruleId} q${t.qstr}  $${t.stake}×${t.lev}× pnl=${t.pnl >= 0 ? "+" : ""}$${t.pnl.toFixed(2)} ${tag} ${t.reason}`);
  }

  if (open.length > 0) {
    console.log(`\nStill-open positions:`);
    for (const p of open) {
      console.log(`  opened ${new Date(p.openEpoch * 1000).toISOString().slice(11, 16)}  ${p.asset.padEnd(10)} ${p.side.padEnd(5)} ${p.ruleId} q${p.qstr}  $${p.stake}×${p.lev}× entry=${p.entry.toFixed(5)} peak=${p.peakFav.toFixed(5)} ${p.armed ? "ARMED" : "tracking"}`);
    }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
