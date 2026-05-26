// Bucket 8 — Cross-asset / correlation.
// Hypothesis: in crypto, BTC leads; ETH co-moves; alts follow with delay.
// Lead-lag trades exploit this latency. Pair / basket trades exploit
// correlation breakdowns.
//
// Pre-loads BTC and ETH separately for use as reference series. Strategies
// per-asset compare current asset's recent return against the reference.
//
// Run: npx tsx scripts/hf-screen/bucket-08-crossasset.ts

import { Strategy, BarContext, runBucket } from "./lib";
import { load1m, roll, defaultWindow } from "./lib";

// Pre-build BTC and ETH 15m close series indexed by epoch.
function buildRef(sym: string): Map<number, { close: number; ret15: number }> {
  const { fromEpoch, toEpoch } = defaultWindow();
  const bars1m = load1m(sym, fromEpoch - 30 * 86400, toEpoch);
  const bars15m = roll(bars1m, 900);
  const m = new Map<number, { close: number; ret15: number }>();
  for (let i = 1; i < bars15m.length; i++) {
    const ret15 = (bars15m[i].close - bars15m[i - 1].close) / bars15m[i - 1].close;
    m.set(bars15m[i].epoch, { close: bars15m[i].close, ret15 });
  }
  return m;
}

console.log("Pre-loading BTC + ETH reference series...");
const REF_BTC = buildRef("BTCUSDT");
const REF_ETH = buildRef("ETHUSDT");
console.log(`  BTC: ${REF_BTC.size} bars  ETH: ${REF_ETH.size} bars\n`);

function btcRetN(c: BarContext, n: number): number | null {
  if (c.i < n) return null;
  const btcNow = REF_BTC.get(c.bars15m[c.i].epoch);
  const btcPrev = REF_BTC.get(c.bars15m[c.i - n].epoch);
  if (!btcNow || !btcPrev) return null;
  return (btcNow.close - btcPrev.close) / btcPrev.close;
}
function ethRetN(c: BarContext, n: number): number | null {
  if (c.i < n) return null;
  const e0 = REF_ETH.get(c.bars15m[c.i].epoch);
  const e1 = REF_ETH.get(c.bars15m[c.i - n].epoch);
  if (!e0 || !e1) return null;
  return (e0.close - e1.close) / e1.close;
}
function selfRetN(c: BarContext, n: number): number | null {
  if (c.i < n) return null;
  return (c.bars15m[c.i].close - c.bars15m[c.i - n].close) / c.bars15m[c.i - n].close;
}

const strategies: Strategy[] = [
  {
    id: "B8-01",
    name: "BTC leads — BTC up >0.5% in 1 bar, asset flat, buy laggard",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      const btcRet = btcRetN(c, 1);
      const selfRet = selfRetN(c, 1);
      if (btcRet === null || selfRet === null) return null;
      if (btcRet > 0.005 && selfRet < 0.001) return { side: "LONG" };
      if (btcRet < -0.005 && selfRet > -0.001) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-02",
    name: "BTC leads stronger — BTC up >0.5% in 4 bars, asset hasn't moved",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      const btcRet = btcRetN(c, 4);
      const selfRet = selfRetN(c, 4);
      if (btcRet === null || selfRet === null) return null;
      if (btcRet > 0.005 && selfRet < 0.002) return { side: "LONG" };
      if (btcRet < -0.005 && selfRet > -0.002) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-03",
    name: "BTC divergence — BTC down, asset up = asset strength → continue long",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      const btcRet = btcRetN(c, 4);
      const selfRet = selfRetN(c, 4);
      if (btcRet === null || selfRet === null) return null;
      if (btcRet < -0.003 && selfRet > 0.003) return { side: "LONG" };
      if (btcRet > 0.003 && selfRet < -0.003) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-04",
    name: "ETH leads alts (non-BTC) — ETH +0.5% 1 bar, alt flat",
    fn: (c) => {
      if (c.asset === "ETHUSDT" || c.asset === "BTCUSDT") return null;
      const ethRet = ethRetN(c, 1);
      const selfRet = selfRetN(c, 1);
      if (ethRet === null || selfRet === null) return null;
      if (ethRet > 0.005 && selfRet < 0.001) return { side: "LONG" };
      if (ethRet < -0.005 && selfRet > -0.001) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-05",
    name: "BTC.D proxy: alt outperforms BTC by 1% in 4 bars → fade alt strength",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      const btcRet = btcRetN(c, 4);
      const selfRet = selfRetN(c, 4);
      if (btcRet === null || selfRet === null) return null;
      if (selfRet - btcRet > 0.01) return { side: "SHORT" };
      if (selfRet - btcRet < -0.01) return { side: "LONG" };
      return null;
    },
  },
  {
    id: "B8-06",
    name: "Lead-lag: BTC 5m momentum into alt 15m entry",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      // approximate: BTC return over last bar (15m) vs alt last bar
      const btcRet = btcRetN(c, 1);
      const selfRet = selfRetN(c, 1);
      if (btcRet === null || selfRet === null) return null;
      // BTC moving strongly, alt hasn't followed yet
      if (btcRet > 0.003 && selfRet < btcRet * 0.5) return { side: "LONG" };
      if (btcRet < -0.003 && selfRet > btcRet * 0.5) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-07",
    name: "Correlation breakdown — alt moves opposite to BTC by >0.5% in 1 bar",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      const btcRet = btcRetN(c, 1);
      const selfRet = selfRetN(c, 1);
      if (btcRet === null || selfRet === null) return null;
      // Mean-reverting bet on correlation: if alt diverges from BTC, expect reversion
      if (btcRet > 0.003 && selfRet < -0.003) return { side: "LONG" };  // alt should follow BTC up
      if (btcRet < -0.003 && selfRet > 0.003) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-08",
    name: "BTC trend regime + alt mean-revert: BTC > EMA50_1h → buy alt dips",
    fn: (c) => {
      if (c.asset === "BTCUSDT" || !isFinite(c.ema50_1h)) return null;
      const btcNow = REF_BTC.get(c.bars15m[c.i].epoch);
      if (!btcNow) return null;
      // Get BTC 1h trend: approximate via comparing BTC close to BTC close 12 bars ago (3h)
      const btcPrev3h = REF_BTC.get(c.bars15m[c.i - 12]?.epoch);
      if (!btcPrev3h) return null;
      const btcBull = btcNow.close > btcPrev3h.close;
      if (!c.bbObj) return null;
      const b = c.bars15m[c.i];
      if (btcBull && b.low <= c.bbObj.lower && b.close > c.bbObj.lower) return { side: "LONG" };
      if (!btcBull && b.high >= c.bbObj.upper && b.close < c.bbObj.upper) return { side: "SHORT" };
      return null;
    },
  },
  {
    id: "B8-09",
    name: "BTC-ETH ratio z-score reversion — extreme ratio fades",
    fn: (c) => {
      if (c.asset !== "ETHUSDT" && c.asset !== "BTCUSDT") return null;
      // Build the ratio at current bar and 30-bar rolling z-score
      const btc0 = REF_BTC.get(c.bars15m[c.i].epoch);
      const eth0 = REF_ETH.get(c.bars15m[c.i].epoch);
      if (!btc0 || !eth0) return null;
      const r0 = btc0.close / eth0.close;
      const rs: number[] = [];
      for (let j = c.i - 30; j < c.i; j++) {
        const b = REF_BTC.get(c.bars15m[j]?.epoch);
        const e = REF_ETH.get(c.bars15m[j]?.epoch);
        if (b && e) rs.push(b.close / e.close);
      }
      if (rs.length < 20) return null;
      const m = rs.reduce((s, x) => s + x, 0) / rs.length;
      const v = rs.reduce((s, x) => s + (x - m) * (x - m), 0) / rs.length;
      const sd = Math.sqrt(v);
      if (sd === 0) return null;
      const z = (r0 - m) / sd;
      if (z > 2.0) {
        // ratio extended; BTC over-rich vs ETH — fade by shorting BTC / longing ETH
        if (c.asset === "BTCUSDT") return { side: "SHORT" };
        if (c.asset === "ETHUSDT") return { side: "LONG" };
      }
      if (z < -2.0) {
        if (c.asset === "BTCUSDT") return { side: "LONG" };
        if (c.asset === "ETHUSDT") return { side: "SHORT" };
      }
      return null;
    },
  },
  {
    id: "B8-10",
    name: "Beta-adjusted: BTC moves >1% but alt-vs-historical-beta gap is large",
    fn: (c) => {
      if (c.asset === "BTCUSDT") return null;
      // Compute alt beta over last 60 bars
      const btcRets: number[] = [], selfRets: number[] = [];
      for (let j = c.i - 60; j < c.i; j++) {
        const b0 = REF_BTC.get(c.bars15m[j]?.epoch);
        const b1 = REF_BTC.get(c.bars15m[j - 1]?.epoch);
        if (!b0 || !b1) continue;
        btcRets.push((b0.close - b1.close) / b1.close);
        selfRets.push((c.bars15m[j].close - c.bars15m[j - 1].close) / c.bars15m[j - 1].close);
      }
      if (btcRets.length < 30) return null;
      const meanB = btcRets.reduce((s, x) => s + x, 0) / btcRets.length;
      const meanS = selfRets.reduce((s, x) => s + x, 0) / selfRets.length;
      let cov = 0, varB = 0;
      for (let i = 0; i < btcRets.length; i++) {
        cov += (btcRets[i] - meanB) * (selfRets[i] - meanS);
        varB += (btcRets[i] - meanB) * (btcRets[i] - meanB);
      }
      const beta = varB > 0 ? cov / varB : 1;
      const btcRet = btcRetN(c, 1);
      const selfRet = selfRetN(c, 1);
      if (btcRet === null || selfRet === null) return null;
      if (Math.abs(btcRet) < 0.005) return null;
      const expected = beta * btcRet;
      const gap = selfRet - expected;
      // Alt underperformed expectation → expect catch-up
      if (btcRet > 0 && gap < -0.003) return { side: "LONG" };
      if (btcRet < 0 && gap > 0.003) return { side: "SHORT" };
      return null;
    },
  },
];

runBucket("bucket-08-crossasset", strategies).catch(e => { console.error(e); process.exit(1); });
