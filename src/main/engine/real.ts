import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DerivClient } from "../deriv/client";
import type { OpenContractInfo } from "../deriv/types";
import type {
  AccountInfo,
  ContractFamily,
  RealState,
  RealTrade,
  RealTradeSide,
  SymbolCode,
} from "@shared/types";
import {
  computeStakeMultiplier,
  describeShiftState,
  emptyAdaptiveShiftState,
  updateAfterTrade,
  type AdaptiveShiftState,
} from "./adaptive-shift";

/**
 * Real-money trading engine.
 *
 * Responsibilities:
 *   1. Place Deriv Rise/Fall contracts on demand (signal-driven or manual).
 *   2. Listen to contract settlement updates and record outcomes.
 *   3. Enforce per-trade + daily-loss caps. Emits "capHit" + auto-disables
 *      real mode when the day's realised loss crosses the cap.
 */

export type RealEngineEvents = {
  opened: [RealTrade];
  settled: [RealTrade];
  capHit: [dailyLoss: number, cap: number];
  error: [Error];
  stateChanged: [];
  /** Fires whenever the adaptive shift state changes (after each settle). Caller must persist. */
  adaptiveShiftChanged: [AdaptiveShiftState];
};

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function emptyDaily(): RealState["daily"] {
  return { date: utcToday(), profit: 0, tradesOpened: 0, capHit: false };
}

export class RealEngine extends EventEmitter {
  private open: RealTrade[] = [];
  private closed: RealTrade[] = [];
  private daily: RealState["daily"] = emptyDaily();
  private byContractId = new Map<number, RealTrade>();
  /** Set of contract IDs with an in-flight sell — prevents multiple ticks
   *  from each firing a duplicate manual-sell when the bot-managed TP/SL
   *  trips. Cleared on settlement (when the contract leaves byContractId). */
  private sellInFlight = new Set<number>();
  private account: AccountInfo | null = null;
  private perTradeMaxStake = 0;
  private dailyMaxLoss = 0;
  /** Adaptive shift state — modulates stake size based on recent loss patterns. */
  private adaptiveShift: AdaptiveShiftState = emptyAdaptiveShiftState();
  /** Floor stake (e.g., $1) so post-modulation stake never goes below broker minimum. */
  private minBrokerStake = 1;
  /** Max acceptable price slippage between signal-fire and contract-open as
   *  a fraction of price (e.g. 0.0005 = 5 bps = ~0.05%). If the latest tick
   *  has drifted further than this from the signal's expected entry, the
   *  trade is aborted. Set to 0 to disable. Tunable via setPriceTolerance. */
  private priceToleranceFrac = 0.0005;
  /** Rolling buffer of recent open-latency samples (ms) — bot/index.ts uses
   *  this for the "if avg latency over last N is high, pause trading"
   *  circuit breaker. */
  private recentOpenLatenciesMs: number[] = [];
  private static readonly LATENCY_BUFFER_SIZE = 20;

  constructor(private readonly deriv: DerivClient) {
    super();
    this.deriv.on("contract", (c) => this.onContractUpdate(c));
  }

  load(state: Partial<RealState>) {
    this.open = state.open ?? [];
    this.closed = state.closed ?? [];
    this.daily = state.daily ?? emptyDaily();
    this.byContractId = new Map(
      [...this.open, ...this.closed].map((t) => [t.contractId, t] as const),
    );
    this.rollDayIfNeeded();
  }

  loadAdaptiveShift(state: AdaptiveShiftState) {
    this.adaptiveShift = state;
  }

  getAdaptiveShift(): AdaptiveShiftState {
    return this.adaptiveShift;
  }

  describeAdaptiveShift(): string {
    return describeShiftState(this.adaptiveShift);
  }

  setAccount(account: AccountInfo | null) {
    this.account = account;
  }

  setCaps(perTradeMaxStake: number, dailyMaxLoss: number) {
    this.perTradeMaxStake = perTradeMaxStake;
    this.dailyMaxLoss = dailyMaxLoss;
  }

  /** Production safety: configure max acceptable price slippage (fraction of
   *  price) between signal-fire and the latest tick. 0 disables. Typical
   *  value for 1m synthetic strategies: 0.0005 (5bps ≈ 0.05%). */
  setPriceTolerance(frac: number) {
    this.priceToleranceFrac = Math.max(0, frac);
  }

  /** Push a new open-latency sample (ms). Bounded ring buffer kept short so
   *  the rolling average reacts to recent regime, not stale history. */
  private recordOpenLatency(ms: number) {
    this.recentOpenLatenciesMs.push(ms);
    if (this.recentOpenLatenciesMs.length > RealEngine.LATENCY_BUFFER_SIZE) {
      this.recentOpenLatenciesMs.splice(0, this.recentOpenLatenciesMs.length - RealEngine.LATENCY_BUFFER_SIZE);
    }
  }

  /** Average of the last N (≤ 20) open latencies in ms, or null if no
   *  samples yet. Used by the latency-circuit breaker. */
  averageOpenLatencyMs(): number | null {
    if (this.recentOpenLatenciesMs.length === 0) return null;
    const sum = this.recentOpenLatenciesMs.reduce((a, b) => a + b, 0);
    return sum / this.recentOpenLatenciesMs.length;
  }

  /** Number of latency samples currently in the rolling buffer. Used by the
   *  latency circuit to require a minimum sample count before tripping —
   *  prevents one slow buy from blowing the circuit. */
  recentOpenLatencySampleCount(): number {
    return this.recentOpenLatenciesMs.length;
  }

  /** Hydrate open/closed contract history from Deriv's authoritative state.
   *  Used at bot startup when local state was wiped (Railway redeploy etc.)
   *  so the UI can show the user's actual trade history even after a fresh
   *  install.
   *
   *  Pulls in:
   *    • portfolio: 1   → currently open contracts (re-subscribes to each
   *                       so settlement events flow back through onContractUpdate)
   *    • profit_table   → recent closed contracts (last `closedLimit`)
   */
  async restoreFromDeriv(closedLimit: number = 100): Promise<{ openImported: number; closedImported: number }> {
    let openImported = 0;
    let closedImported = 0;

    // Open contracts ----------------------------------------------------
    try {
      const portfolio = await this.deriv.fetchPortfolio();
      for (const c of portfolio) {
        const info = c as Record<string, unknown>;
        const contractId = Number(info.contract_id ?? 0);
        if (!contractId) continue;
        if (this.byContractId.has(contractId)) continue; // already known
        const trade = this.contractToTrade(info, /*open=*/ true);
        if (!trade) continue;
        this.open.push(trade);
        this.byContractId.set(contractId, trade);
        openImported++;
        // Re-attach to the contract update stream so settlement flows in
        // exactly as it does for trades opened by the bot itself. Without
        // the subscribe call, the snapshot below is the only update we'd
        // ever see — a still-open contract would never settle in the bot.
        try {
          const live = await this.deriv.getOpenContract(contractId);
          if (live) this.onContractUpdate(live as Parameters<typeof this.onContractUpdate>[0]);
        } catch { /* ignore — best-effort hydration */ }
        if (this.open.find((o) => o.contractId === contractId)) {
          this.deriv.subscribeOpenContract(contractId);
        }
      }
    } catch (e) {
      // Don't throw — startup must continue even if portfolio fetch fails.
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }

    // Closed contract history -------------------------------------------
    try {
      const transactions = await this.deriv.fetchProfitTable(closedLimit);
      // Newest first from Deriv → reverse so we unshift in chronological order
      // and end up with newest at the head of `closed` (matches existing
      // "this.closed.unshift" convention in onContractUpdate).
      for (const t of [...transactions].reverse()) {
        const info = t as Record<string, unknown>;
        const contractId = Number(info.contract_id ?? 0);
        if (!contractId) continue;
        if (this.byContractId.has(contractId)) continue; // already known (open or closed)
        const trade = this.contractToTrade(info, /*open=*/ false);
        if (!trade) continue;
        this.closed.unshift(trade);
        this.byContractId.set(contractId, trade);
        closedImported++;
      }
      if (this.closed.length > 500) this.closed.length = 500;
    } catch (e) {
      this.emit("error", e instanceof Error ? e : new Error(String(e)));
    }

    return { openImported, closedImported };
  }

  /** Convert a Deriv contract record (from portfolio or profit_table) into
   *  a RealTrade we can store. */
  private contractToTrade(info: Record<string, unknown>, isOpen: boolean): RealTrade | null {
    const contractId = Number(info.contract_id ?? 0);
    if (!contractId) return null;
    // profit_table responses use `shortcode` (e.g. "MULTUP_RDBULL_5.00_100_…")
    // rather than top-level symbol/contract_type fields, so derive everything
    // from shortcode when those fields are absent.
    const shortcode = String(info.shortcode ?? "");
    let contractType = String(info.contract_type ?? "");
    let symbol = String(info.symbol ?? info.underlying_symbol ?? "");
    if ((!contractType || !symbol) && shortcode) {
      const parts = shortcode.split("_");
      if (!contractType && parts[0]) contractType = parts[0];
      if (!symbol && parts[1]) symbol = parts[1];
    }
    if (!symbol) return null;
    const isMultiplier = contractType.startsWith("MULT");
    const isDigit = contractType.startsWith("DIGIT");
    const family: ContractFamily = isDigit ? "DIGIT" : isMultiplier ? "MULTIPLIER" : "CALL_PUT";
    const side: RealTradeSide = (contractType === "MULTUP" || contractType === "CALL") ? "BUY" : "SELL";
    // Narrow to RealTrade["contractType"] union. Anything outside the set
    // (unexpected from Deriv) maps to a side-derived default so we never
    // store an arbitrary string.
    const KNOWN_CTS: RealTrade["contractType"][] = ["CALL", "PUT", "MULTUP", "MULTDOWN", "DIGITODD", "DIGITEVEN", "DIGITOVER", "DIGITUNDER", "DIGITMATCH", "DIGITDIFF"];
    const ct: RealTrade["contractType"] =
      (KNOWN_CTS as string[]).includes(contractType)
        ? contractType as RealTrade["contractType"]
        : (isMultiplier ? (side === "BUY" ? "MULTUP" : "MULTDOWN") : (side === "BUY" ? "CALL" : "PUT"));
    const buyPrice = Number(info.buy_price ?? 0);
    const sellPrice = info.sell_price != null ? Number(info.sell_price) : null;
    const stake = Number(info.buy_price ?? info.stake ?? 0);
    const payout = info.payout != null ? Number(info.payout) : null;
    // profit_table doesn't include a top-level `profit` field — compute it
    // from sell_price - buy_price (Deriv's convention for closed contracts).
    // For currently-open contracts (portfolio), profit may still be present
    // as a "current floating P/L" — pass it through.
    const profit = info.profit != null
      ? Number(info.profit)
      : (sellPrice != null && Number.isFinite(buyPrice))
        ? Number((sellPrice - buyPrice).toFixed(2))
        : null;
    const entrySpot = info.entry_spot != null ? Number(info.entry_spot) : (info.entry_tick != null ? Number(info.entry_tick) : null);
    const exitSpot = info.exit_spot != null ? Number(info.exit_spot) : (info.exit_tick != null ? Number(info.exit_tick) : null);
    const openedAt = Number(info.purchase_time ?? info.date_start ?? 0) * 1000;
    const closedAt = isOpen ? null : Number(info.sell_time ?? info.transaction_time ?? 0) * 1000;
    // Status: only call it "won" when we actually know profit > 0. If profit
    // is null (couldn't compute), mark as "cancelled" — it's the closest of
    // the four allowed states and signals "settled but P/L unknown" to the UI.
    const status: RealTrade["status"] = isOpen ? "open" : (profit == null ? "cancelled" : profit > 0 ? "won" : "lost");
    const multiplier = info.multiplier != null ? Number(info.multiplier) : undefined;
    const takeProfit = info.take_profit != null ? Number((info.take_profit as { order_amount?: number })?.order_amount ?? info.take_profit) : null;
    const stopLoss = info.stop_loss != null ? Number((info.stop_loss as { order_amount?: number })?.order_amount ?? info.stop_loss) : null;

    return {
      id: randomUUID(),
      contractId,
      symbol: symbol as SymbolCode,
      side,
      family,
      contractType: ct,
      stake,
      currency: this.account?.currency ?? "USD",
      entrySpot,
      exitSpot,
      buyPrice,
      payout,
      multiplier,
      takeProfit,
      stopLoss,
      openedAt,
      closedAt,
      status,
      profit,
      detector: "restored",
      sandbox: "real",
      sandboxStrategyId: undefined,
    };
  }

  /** Reconcile every open contract against Deriv. Used post-WS-reconnect and
   *  available as a manual /api/control/reconcile-contracts trigger.
   *
   *  For each locally-open trade:
   *    1. Pull a one-shot snapshot via proposal_open_contract.
   *    2. Pipe it through onContractUpdate — settles trades that finalised
   *       during the disconnect window.
   *    3. If still open after that, RE-SUBSCRIBE so future updates arrive.
   *       Without step 3, the prior reconcile path was a snapshot-only fix:
   *       it picked up settlements that happened before reconcile ran but
   *       left the trade with no live stream, so subsequent settlement was
   *       silently dropped → trade stuck "open" forever. */
  async reconcileOpenContracts(): Promise<{ reconciled: number; settled: number; resubscribed: number; errors: number }> {
    let reconciled = 0;
    let settled = 0;
    let resubscribed = 0;
    let errors = 0;
    const snapshot = this.open.slice();
    for (const t of snapshot) {
      try {
        const info = await this.deriv.getOpenContract(t.contractId);
        if (info) {
          this.onContractUpdate(info as Parameters<typeof this.onContractUpdate>[0]);
          reconciled++;
          // Trade finalised during the disconnect — onContractUpdate moved it
          // to closed already; nothing more to wire up.
          if (!this.byContractId.get(t.contractId) || !this.open.find((o) => o.contractId === t.contractId)) {
            settled++;
            continue;
          }
        }
        // Still open: re-attach the live stream so the next settlement update
        // arrives through the normal onContractUpdate path.
        this.deriv.subscribeOpenContract(t.contractId);
        resubscribed++;
      } catch {
        errors++;
      }
    }
    return { reconciled, settled, resubscribed, errors };
  }

  private rollDayIfNeeded() {
    const today = utcToday();
    if (this.daily.date !== today) this.daily = emptyDaily();
  }

  canOpen(): { ok: true } | { ok: false; reason: string } {
    this.rollDayIfNeeded();
    if (!this.account) return { ok: false, reason: "No account (authorize first)" };
    if (this.perTradeMaxStake <= 0) return { ok: false, reason: "Per-trade max stake not set" };
    if (this.dailyMaxLoss <= 0) return { ok: false, reason: "Daily max loss cap not set" };
    if (this.daily.capHit) return { ok: false, reason: "Daily loss cap already hit — trading paused" };
    if (-this.daily.profit >= this.dailyMaxLoss) {
      this.daily.capHit = true;
      return { ok: false, reason: "Daily loss cap reached" };
    }
    // 3-position cap removed 2026-05-04 — was blocking every fast3 buy because
    // 3 stale 'real'-sandbox contracts from before fast3 era are permanently
    // occupying the cap. Daily-loss cap above still bounds total exposure.
    return { ok: true };
  }

  async placeTrade(params: {
    symbol: SymbolCode;
    side: RealTradeSide;
    family: ContractFamily;
    detector: string;
    // CALL_PUT
    durationTicks?: number;
    // MULTIPLIER
    multiplier?: number;
    // TP/SL configuration
    tpSlMode?: "percent" | "atr";
    takeProfitPct?: number;  // % of stake (0 = no TP)
    stopLossPct?: number;    // % of stake (0 = no SL)
    atrTpMult?: number;      // TP at N * ATR price move
    atrSlMult?: number;      // SL at N * ATR price move
    atr?: number;            // current ATR — required when tpSlMode === "atr"
    entryPriceHint?: number; // most recent close — required when tpSlMode === "atr"
    /** Structural SL price emitted by the detector. Overrides ATR-based SL
     *  when present and on the correct side of entry. */
    signalStopPrice?: number;
    /** Structural TP price emitted by the detector. Overrides ATR-based TP. */
    signalTargetPrice?: number;
    /** Wall-clock ms when the signal fired. Used for latency telemetry. */
    signalFiredAt?: number;
    /** Stake override (e.g., martingale-derived). Bypasses adaptive shift. */
    stakeOverride?: number;
    /** Origin sandbox tag — propagated onto the RealTrade so the settle
     *  handler can advance the right martingale ladder. Defaults to "real". */
    sandbox?: "real" | "fast" | "fast2" | "fast3";
    /** Strategy id within the origin sandbox (e.g. "fast2_rdbear_meanrev"). */
    sandboxStrategyId?: string;
    /** DIGIT family contract type — DIGITODD/DIGITEVEN are the only ones the
     *  bot currently uses (no barrier needed). 1-tick duration is hardcoded. */
    digitContractType?: "DIGITODD" | "DIGITEVEN" | "DIGITOVER" | "DIGITUNDER" | "DIGITMATCH" | "DIGITDIFF";
    /** Required for OVER/UNDER/MATCH/DIFF contract types — the digit barrier. */
    digitBarrier?: number;
    /** Trailing-exit (ratcheted TP). When enabled, the bot doesn't rely on
     *  the static TP; instead it tick-watches profit and manually sells when
     *  retrace from peak crosses the configured threshold. See FastSandboxConfig
     *  for full semantics. Defaults: enabled=false (preserve prior behavior). */
    trailingExitEnabled?: boolean;
    trailingArmPct?: number;
    trailingRetracePct?: number;
  }): Promise<RealTrade> {
    const gate = this.canOpen();
    if (!gate.ok) throw new Error(gate.reason);
    if (!this.account) throw new Error("No account");

    // Price-tolerance abort: if the latest tick has drifted too far from the
    // signal's expected entry, skip the trade. Better to miss a setup than
    // fill at a stale price after WS or processing latency. Only checks if
    // we have both a signal entry hint and a recent tick.
    if (this.priceToleranceFrac > 0 && params.entryPriceHint && params.entryPriceHint > 0) {
      const tick = this.deriv.lastTickFor(params.symbol);
      if (tick && tick.quote > 0) {
        const drift = Math.abs(tick.quote - params.entryPriceHint) / params.entryPriceHint;
        if (drift > this.priceToleranceFrac) {
          throw new Error(`price-tolerance abort: tick ${tick.quote} drifted ${(drift * 10000).toFixed(1)}bps from signal entry ${params.entryPriceHint} (tolerance ${(this.priceToleranceFrac * 10000).toFixed(1)}bps)`);
        }
      }
    }

    // Stake selection: override (martingale ladder) wins over adaptive-shift.
    // Adaptive shift: modulate stake by recent loss-pattern + side-bias + metals burst.
    // Per-family broker minimum: DIGIT contracts accept $0.35 on Deriv
    // synthetics; MULTIPLIER (and CALL_PUT) require $1. Verified empirically
    // 2026-05-05 against R_100 proposal endpoint.
    const familyMinStake = params.family === "DIGIT" ? 0.35 : this.minBrokerStake;
    let stake: number;
    let mult = 1;
    let reasons: string[] = [];
    if (params.stakeOverride != null && isFinite(params.stakeOverride) && params.stakeOverride > 0) {
      stake = Math.max(familyMinStake, Math.round(params.stakeOverride * 100) / 100);
      reasons = ["override"];
    } else {
      const baseStake = this.perTradeMaxStake;
      const shift = computeStakeMultiplier(this.adaptiveShift, params.side, params.symbol);
      mult = shift.mult;
      reasons = shift.reasons;
      stake = Math.max(familyMinStake, Math.round(baseStake * mult * 100) / 100);
      if (mult < 1) {
        console.log(`[adaptive-shift] ${params.symbol} ${params.side} stake ${baseStake} → ${stake} (×${mult.toFixed(2)}: ${reasons.join("+")})`);
      }
    }
    let trade: RealTrade;
    const signalFiredAt = params.signalFiredAt ?? null;

    if (params.family === "DIGIT") {
      // DIGITODD / DIGITEVEN — 1-tick binary contract. No SL/TP geometry,
      // payout fixed by Deriv (≈1.95×). Side is encoded purely in the
      // contract type, not the directional BUY/SELL convention.
      const contractType = params.digitContractType ?? "DIGITODD";
      const { proposal, buy } = await this.deriv.placeDigitContract({
        symbol: params.symbol,
        contract_type: contractType,
        stake,
        currency: this.account.currency,
        barrier: params.digitBarrier,
      });
      const contractOpenedAt = Date.now();
      const latency = signalFiredAt != null ? contractOpenedAt - signalFiredAt : null;
      // NOTE: DIGITODD latency is NOT fed into the circuit-breaker. DIGIT
      // contracts are binary fixed-payout — slight latency doesn't affect
      // P&L (no price-stale slip risk like CALL_PUT/MULT). Fast3 fires
      // hundreds of these per minute and would dominate the moving avg,
      // tripping the breaker even when CALL/PUT/MULT trades are healthy.
      trade = {
        id: randomUUID(),
        contractId: buy.contract_id,
        symbol: params.symbol,
        side: params.side,
        family: "DIGIT",
        contractType,
        stake,
        currency: this.account.currency,
        entrySpot: proposal.spot ?? null,
        exitSpot: null,
        buyPrice: buy.buy_price,
        payout: proposal.payout ?? null,
        durationTicks: 1,
        openedAt: contractOpenedAt,
        closedAt: null,
        status: "open",
        profit: null,
        detector: params.detector,
        signalFiredAt,
        signalEntry: params.entryPriceHint ?? null,
        contractOpenedAt,
        entrySlippage: null,
        openLatencyMs: latency,
        sandbox: params.sandbox ?? "real",
        sandboxStrategyId: params.sandboxStrategyId,
      };
    } else if (params.family === "CALL_PUT") {
      const contractType = params.side === "BUY" ? "CALL" : "PUT";
      const durationTicks = params.durationTicks ?? 10;
      const { proposal, buy } = await this.deriv.placeRiseFall({
        symbol: params.symbol,
        contract_type: contractType,
        stake,
        currency: this.account.currency,
        duration: durationTicks,
        duration_unit: "t",
      });
      const contractOpenedAt = Date.now();
      const entrySpot = proposal.spot ?? null;
      const slip = (entrySpot != null && params.entryPriceHint && params.entryPriceHint > 0)
        ? (params.side === "BUY" ? entrySpot - params.entryPriceHint : params.entryPriceHint - entrySpot)
        : null;
      const latency = signalFiredAt != null ? contractOpenedAt - signalFiredAt : null;
      if (latency != null) this.recordOpenLatency(latency);
      trade = {
        id: randomUUID(),
        contractId: buy.contract_id,
        symbol: params.symbol,
        side: params.side,
        family: "CALL_PUT",
        contractType,
        stake,
        currency: this.account.currency,
        entrySpot,
        exitSpot: null,
        buyPrice: buy.buy_price,
        payout: proposal.payout ?? null,
        durationTicks,
        openedAt: contractOpenedAt,
        closedAt: null,
        status: "open",
        profit: null,
        detector: params.detector,
        signalFiredAt,
        signalEntry: params.entryPriceHint ?? null,
        contractOpenedAt,
        entrySlippage: slip,
        openLatencyMs: latency,
        sandbox: params.sandbox ?? "real",
        sandboxStrategyId: params.sandboxStrategyId,
      };
    } else {
      const contractType = params.side === "BUY" ? "MULTUP" : "MULTDOWN";
      const multiplier = params.multiplier ?? 30;

      let tp: number | undefined;
      let sl: number | undefined;
      const useAtr = params.tpSlMode === "atr" && params.atr && params.atr > 0 && params.entryPriceHint && params.entryPriceHint > 0;

      if (useAtr) {
        const entry = params.entryPriceHint!;
        // Convert any price distance to USD P&L for a MULTUP/DOWN:
        //   profit(d) = (d / entry) * stake * multiplier
        const priceDistToPnl = (d: number) => +((d / entry) * stake * multiplier).toFixed(2);
        // Prefer structural SL/TP emitted by the detector when on the correct
        // side of entry (matches the backtest path so live mirrors validation).
        //
        // CRITICAL: when SL is structural but TP is missing, do NOT fall back
        // to ATR×atrTpMult for TP — that produces an SL/TP unit mismatch
        // (structural SL distance vs. ATR-derived TP distance), which can
        // give 0.1R wins against 1R losses. Instead, derive TP from the
        // structural stop distance × the validated R:R ratio.
        const sigSL = params.signalStopPrice;
        const sigTP = params.signalTargetPrice;
        const slOk = sigSL != null && isFinite(sigSL) && (params.side === "BUY" ? sigSL < entry : sigSL > entry);
        const tpOk = sigTP != null && isFinite(sigTP) && (params.side === "BUY" ? sigTP > entry : sigTP < entry);
        const atrTpMult = params.atrTpMult ?? 0;
        const atrSlMult = params.atrSlMult ?? 0;
        const rrTpOverSl = atrSlMult > 0 ? atrTpMult / atrSlMult : 1;
        const rrSlOverTp = atrTpMult > 0 ? atrSlMult / atrTpMult : 1;
        if (slOk && tpOk) {
          sl = priceDistToPnl(Math.abs(entry - sigSL!));
          tp = priceDistToPnl(Math.abs(sigTP! - entry));
        } else if (slOk) {
          const stopDistance = Math.abs(entry - sigSL!);
          sl = priceDistToPnl(stopDistance);
          if (atrTpMult > 0) tp = priceDistToPnl(stopDistance * rrTpOverSl);
        } else if (tpOk) {
          const tpDistance = Math.abs(sigTP! - entry);
          tp = priceDistToPnl(tpDistance);
          if (atrSlMult > 0) sl = priceDistToPnl(tpDistance * rrSlOverTp);
        } else {
          if (atrSlMult > 0) sl = priceDistToPnl(atrSlMult * params.atr!);
          if (atrTpMult > 0) tp = priceDistToPnl(atrTpMult * params.atr!);
        }
      } else {
        if (params.takeProfitPct && params.takeProfitPct > 0) {
          tp = +(stake * (params.takeProfitPct / 100)).toFixed(2);
        }
        if (params.stopLossPct && params.stopLossPct > 0) {
          sl = +(stake * (params.stopLossPct / 100)).toFixed(2);
        }
      }

      // Deriv enforces a per-symbol minimum on take_profit/stop_loss order
      // amounts. For BOOM300N MULT it's $0.61 (verified 2026-05-19 via
      // ContractBuyValidationError). The earlier $0.10 constant was wrong
      // for some symbols. Use a safer $1.00 floor that's high enough for
      // every synthetic-index/forex MULT contract we trade.
      //
      // BOT-MANAGED TP/SL: when the designed TP$ or SL$ (from strategy
      // geometry) falls below the Deriv floor, send the FLOOR value to
      // Deriv (so the broker accepts the contract) AND store the designed
      // value on the trade as `botManagedTp/Sl`. The tick-watch in
      // onContractUpdate then manually sells when currentProfit crosses
      // the designed threshold — preserving the validated SL/TP geometry
      // regardless of Deriv's contract-level minimums.
      const TP_SL_FLOOR = 1.00;
      const tpDesigned = tp;
      const slDesigned = sl;
      let botManagedTp: number | null = null;
      let botManagedSl: number | null = null;
      const trailingOn = params.trailingExitEnabled === true;
      // TRAILING ENABLED: don't send TP/SL to Deriv at all. The bot manages
      // both via tick-watch + manual sell. Designed values stored on
      // botManagedTakeProfit/StopLoss.
      //
      // Rationale: Deriv enforces BOTH a lower bound (~$0.61 at $4 stake on
      // BOOM300N) AND an upper bound (~50% of stake at small stakes) on
      // TP/SL order amounts. Trying to send a "wide safety net" TP value
      // exceeds the upper bound; sending a clamped narrow one defeats the
      // trail. Easier to send nothing — the MULTIPLIER natural floor at
      // -stake handles outage protection (max loss = stake regardless).
      //
      // NON-TRAILING path: send the designed TP/SL clamped to the broker
      // floor ($1.00 lower bound observed); bot still manages designed
      // trigger via tick-watch for SL when the clamp widened it.
      if (trailingOn) {
        if (tp != null) { botManagedTp = +tp.toFixed(4); tp = undefined; }
        if (sl != null) { botManagedSl = +sl.toFixed(4); sl = undefined; }
      } else {
        if (tp != null && tp < TP_SL_FLOOR) {
          botManagedTp = +tp.toFixed(4);
          tp = TP_SL_FLOOR;
        }
        if (sl != null && sl < TP_SL_FLOOR) {
          botManagedSl = +sl.toFixed(4);
          sl = TP_SL_FLOOR;
        }
      }
      if (botManagedTp != null || botManagedSl != null) {
        console.log(`[real.placeTrade] ${params.symbol} ${params.side} bot-managed: designed TP $${tpDesigned} / SL $${slDesigned}; Deriv-side TP ${tp ?? "(none)"} / SL ${sl ?? "(none)"}${trailingOn ? `; trailing arm=${params.trailingArmPct} retrace=${params.trailingRetracePct}` : ""}.`);
      }

      const { proposal, buy } = await this.deriv.placeMultiplier({
        symbol: params.symbol,
        contract_type: contractType,
        stake,
        currency: this.account.currency,
        multiplier,
        takeProfit: tp,
        stopLoss: sl,
      });
      const contractOpenedAt = Date.now();
      const entrySpot = proposal.spot ?? null;
      const slip = (entrySpot != null && params.entryPriceHint && params.entryPriceHint > 0)
        ? (params.side === "BUY" ? entrySpot - params.entryPriceHint : params.entryPriceHint - entrySpot)
        : null;
      const latency = signalFiredAt != null ? contractOpenedAt - signalFiredAt : null;
      if (latency != null) this.recordOpenLatency(latency);
      trade = {
        id: randomUUID(),
        contractId: buy.contract_id,
        symbol: params.symbol,
        side: params.side,
        family: "MULTIPLIER",
        contractType,
        stake,
        currency: this.account.currency,
        entrySpot,
        exitSpot: null,
        buyPrice: buy.buy_price,
        payout: null,
        multiplier,
        takeProfit: tp ?? null,
        stopLoss: sl ?? null,
        botManagedTakeProfit: botManagedTp,
        botManagedStopLoss: botManagedSl,
        peakProfit: null,
        trailArmed: false,
        trailingExitEnabled: trailingOn,
        trailingArmPct: trailingOn ? params.trailingArmPct ?? 0.95 : undefined,
        trailingRetracePct: trailingOn ? params.trailingRetracePct ?? 0.20 : undefined,
        openedAt: contractOpenedAt,
        closedAt: null,
        status: "open",
        profit: null,
        detector: params.detector,
        signalFiredAt,
        signalEntry: params.entryPriceHint ?? null,
        contractOpenedAt,
        entrySlippage: slip,
        openLatencyMs: latency,
        sandbox: params.sandbox ?? "real",
        sandboxStrategyId: params.sandboxStrategyId,
      };
    }

    this.open.push(trade);
    this.byContractId.set(trade.contractId, trade);
    this.daily.tradesOpened++;
    this.emit("opened", trade);
    this.emit("stateChanged");
    return trade;
  }

  async closeContract(id: string): Promise<void> {
    const trade = this.open.find((t) => t.id === id);
    if (!trade) throw new Error("Position not open");
    if (trade.family !== "MULTIPLIER") {
      throw new Error("Only Multiplier positions can be closed manually (Rise/Fall auto-settles)");
    }
    await this.deriv.sellContract(trade.contractId, 0);
    // Settlement will arrive via proposal_open_contract stream.
  }

  private onContractUpdate(info: OpenContractInfo) {
    const trade = this.byContractId.get(info.contract_id);
    if (!trade) return;
    // Idempotency guard: a trade that's already been settled must not re-fire
    // the settle path. Without this, the stuck-contract watchdog's reconcile
    // call (which pipes proposal_open_contract back through onContractUpdate)
    // would emit "settled" a second time → sandbox listeners (Fast/Fast2/
    // Fast3/Fast4) advance the martingale ladder twice for the same loss.
    // Observed 2026-05-19 on fast LIVE: contract 76161423781 settled at
    // 05:15:08.991 (L0→L1) then again at 05:15:08.998 (L1→L0 with false CB).
    if (trade.closedAt != null) return;

    if (info.entry_spot != null && trade.entrySpot == null) trade.entrySpot = info.entry_spot;

    // Capture live unrealized P&L on every tick — used by the Real / Fast3
    // panel "Open Positions" tables to show whether the trade is currently
    // winning or losing before it settles.
    if (info.profit != null) trade.currentProfit = info.profit;

    const settled =
      info.is_sold === 1 ||
      info.status === "sold" ||
      info.status === "won" ||
      info.status === "lost";

    if (!settled) {
      // BOT-MANAGED TP/SL + TRAILING EXIT.
      //
      // On every contract update tick:
      //   1. Update peakProfit (max profit seen so far for this contract).
      //   2. SL check: if profit drops below -botManagedStopLoss, sell.
      //   3. Trail logic (if trailingExitEnabled):
      //      - Arm once peakProfit >= designedTpPnl * trailingArmPct.
      //      - While armed, sell when profit retraces by trailingRetracePct
      //        from peakProfit. This LETS peak overshoot the designed TP —
      //        you reap any profit beyond TP that the price runs to.
      //   4. Static-TP fallback (if NOT trailing): sell at designed TP.
      // Deriv's broker-side TP/SL serve as outer safety net only.
      //
      // sellInFlight prevents racing ticks from firing duplicate sells.
      const profit = info.profit;
      const peakBefore = trade.peakProfit;
      const armedBefore = trade.trailArmed;
      if (profit != null) {
        // Capture the open-time profit baseline (≈ -commission for MULT)
        // so SL/TP comparisons measure PRICE MOVEMENT only. Without this,
        // when designed SL$ ≈ commission, the SL triggers immediately on
        // the first tick (observed 2026-05-19 contract 76167285861).
        if (trade.openProfit == null) trade.openProfit = profit;
        const movement = profit - trade.openProfit;
        if (trade.peakProfit == null || movement > trade.peakProfit) trade.peakProfit = movement;

        if (!this.sellInFlight.has(trade.contractId)) {
          let trigger: { side: "SL" | "TP" | "TRAIL"; reason: string } | null = null;
          // All comparisons use `movement` (= profit − openProfit) so
          // commission overhead doesn't trip the SL on the first tick.
          // movement = 0 at trade open, then tracks pure price-movement P&L.

          // 1. SL fires regardless of trailing mode.
          if (trade.botManagedStopLoss != null && movement <= -trade.botManagedStopLoss) {
            trigger = { side: "SL", reason: `movement=$${movement.toFixed(3)} <= -$${trade.botManagedStopLoss.toFixed(3)} (profit=$${profit.toFixed(3)})` };
          }
          // 2. Trailing path
          else if (trade.trailingExitEnabled && trade.botManagedTakeProfit != null) {
            const armPct = trade.trailingArmPct ?? 0.95;
            const retracePct = trade.trailingRetracePct ?? 0.20;
            const armThreshold = trade.botManagedTakeProfit * armPct;
            if (!trade.trailArmed && (trade.peakProfit ?? 0) >= armThreshold) {
              trade.trailArmed = true;
              console.log(`[real.trail] ${trade.symbol} contract=${trade.contractId} trail ARMED at peak-movement=$${trade.peakProfit?.toFixed(3)} (threshold $${armThreshold.toFixed(3)})`);
            }
            if (trade.trailArmed) {
              const exitMovement = (trade.peakProfit ?? 0) * (1 - retracePct);
              if (movement <= exitMovement) {
                trigger = { side: "TRAIL", reason: `movement=$${movement.toFixed(3)} retraced from peak=$${trade.peakProfit?.toFixed(3)} past $${exitMovement.toFixed(3)} threshold (${(retracePct*100).toFixed(0)}% retrace; profit=$${profit.toFixed(3)})` };
              }
            }
          }
          // 3. Static TP only when trailing is OFF
          else if (trade.botManagedTakeProfit != null && movement >= trade.botManagedTakeProfit) {
            trigger = { side: "TP", reason: `movement=$${movement.toFixed(3)} >= $${trade.botManagedTakeProfit.toFixed(3)} (profit=$${profit.toFixed(3)})` };
          }

          if (trigger) {
            console.log(`[real.bot${trigger.side}] ${trade.symbol} contract=${trade.contractId} ${trigger.reason}. Selling.`);
            this.sellInFlight.add(trade.contractId);
            this.deriv.sellContract(trade.contractId, 0).catch((e) => {
              console.error(`[real.bot${trigger!.side}] sell failed: ${(e as Error).message}`);
              this.sellInFlight.delete(trade.contractId);
            });
            this.emit("tickDiag", {
              contractId: trade.contractId,
              sandbox: trade.sandbox,
              event: "sell-triggered",
              side: trigger.side,
              profit,
              peak: trade.peakProfit,
              armed: trade.trailArmed,
              reason: trigger.reason,
            });
          } else {
            // Always emit a diagnostic tick so the operator can watch
            // profit/peak/armed evolve in the log. Bot listens and writes
            // a structured log entry for sandbox="fast" contracts.
            this.emit("tickDiag", {
              contractId: trade.contractId,
              sandbox: trade.sandbox,
              event: (!armedBefore && trade.trailArmed) ? "armed"
                   : (peakBefore == null || (trade.peakProfit != null && trade.peakProfit > peakBefore)) ? "peak-up"
                   : "tick",
              profit,
              movement,
              peak: trade.peakProfit,
              armed: trade.trailArmed,
              armThreshold: trade.botManagedTakeProfit != null && trade.trailingArmPct != null
                ? +(trade.botManagedTakeProfit * trade.trailingArmPct).toFixed(4)
                : null,
              trailExitAt: trade.trailArmed && trade.peakProfit != null && trade.trailingRetracePct != null
                ? +(trade.peakProfit * (1 - trade.trailingRetracePct)).toFixed(4)
                : null,
              slAt: trade.botManagedStopLoss != null ? -trade.botManagedStopLoss : null,
            });
          }
        }
      }
      this.emit("stateChanged");
      return;
    }

    trade.exitSpot = info.exit_tick ?? trade.exitSpot;
    trade.closedAt = info.sell_time ? info.sell_time * 1000 : Date.now();
    trade.profit = info.profit ?? 0;
    trade.status = info.status === "won" ? "won" : info.status === "lost" ? "lost" : trade.profit >= 0 ? "won" : "lost";

    // Move from open → closed. ALSO remove from the byContractId map so a
    // subsequent reconcile pass (watchdog) doesn't pick this trade up and
    // attempt to re-settle it. The closedAt guard above is a belt; this is
    // the suspenders.
    this.open = this.open.filter((t) => t.id !== trade.id);
    this.byContractId.delete(info.contract_id);
    this.sellInFlight.delete(info.contract_id);
    this.closed.unshift(trade);
    if (this.closed.length > 500) this.closed.length = 500;

    this.rollDayIfNeeded();
    this.daily.profit += trade.profit ?? 0;

    // Adaptive shift: update history with the W/L outcome and persist.
    const result: "W" | "L" = (trade.profit ?? 0) > 0 ? "W" : "L";
    this.adaptiveShift = updateAfterTrade(
      this.adaptiveShift,
      result,
      trade.side as "BUY" | "SELL",
      trade.symbol,
      trade.closedAt ?? Date.now(),
    );
    this.emit("adaptiveShiftChanged", this.adaptiveShift);

    this.emit("settled", trade);
    this.emit("stateChanged");

    // Cap check
    if (-this.daily.profit >= this.dailyMaxLoss && !this.daily.capHit) {
      this.daily.capHit = true;
      this.emit("capHit", -this.daily.profit, this.dailyMaxLoss);
      this.emit("stateChanged");
    }
  }

  resetDaily() {
    this.daily = emptyDaily();
    this.emit("stateChanged");
  }

  state(): RealState {
    const wins = this.closed.filter((t) => (t.profit ?? 0) > 0).length;
    const totalProfit = this.closed.reduce((s, t) => s + (t.profit ?? 0), 0);
    return {
      open: this.open,
      closed: this.closed,
      stats: {
        totalClosed: this.closed.length,
        wins,
        winRate: this.closed.length > 0 ? wins / this.closed.length : 0,
        totalProfit,
        currency: this.account?.currency ?? null,
      },
      daily: this.daily,
    };
  }
}
