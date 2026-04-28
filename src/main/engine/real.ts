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
  private account: AccountInfo | null = null;
  private perTradeMaxStake = 0;
  private dailyMaxLoss = 0;
  /** Adaptive shift state — modulates stake size based on recent loss patterns. */
  private adaptiveShift: AdaptiveShiftState = emptyAdaptiveShiftState();
  /** Floor stake (e.g., $1) so post-modulation stake never goes below broker minimum. */
  private minBrokerStake = 1;

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
    if (this.open.length >= 3) return { ok: false, reason: "Max 3 concurrent real positions" };
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
  }): Promise<RealTrade> {
    const gate = this.canOpen();
    if (!gate.ok) throw new Error(gate.reason);
    if (!this.account) throw new Error("No account");

    // Adaptive shift: modulate stake by recent loss-pattern + side-bias + metals burst.
    const baseStake = this.perTradeMaxStake;
    const { mult, reasons } = computeStakeMultiplier(this.adaptiveShift, params.side, params.symbol);
    const modulated = Math.max(this.minBrokerStake, Math.round(baseStake * mult * 100) / 100);
    const stake = modulated;
    if (mult < 1) {
      console.log(`[adaptive-shift] ${params.symbol} ${params.side} stake ${baseStake} → ${stake} (×${mult.toFixed(2)}: ${reasons.join("+")})`);
    }
    let trade: RealTrade;

    if (params.family === "CALL_PUT") {
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
      trade = {
        id: randomUUID(),
        contractId: buy.contract_id,
        symbol: params.symbol,
        side: params.side,
        family: "CALL_PUT",
        contractType,
        stake,
        currency: this.account.currency,
        entrySpot: proposal.spot ?? null,
        exitSpot: null,
        buyPrice: buy.buy_price,
        payout: proposal.payout ?? null,
        durationTicks,
        openedAt: Date.now(),
        closedAt: null,
        status: "open",
        profit: null,
        detector: params.detector,
      };
    } else {
      const contractType = params.side === "BUY" ? "MULTUP" : "MULTDOWN";
      const multiplier = params.multiplier ?? 30;

      let tp: number | undefined;
      let sl: number | undefined;
      const useAtr = params.tpSlMode === "atr" && params.atr && params.atr > 0 && params.entryPriceHint && params.entryPriceHint > 0;

      if (useAtr) {
        // For a MULTUP/DOWN, profit for a price move of d = (d / entry) * stake * multiplier.
        const atrPnL = (mult: number) => +(((mult * params.atr!) / params.entryPriceHint!) * stake * multiplier).toFixed(2);
        if (params.atrTpMult && params.atrTpMult > 0) tp = atrPnL(params.atrTpMult);
        if (params.atrSlMult && params.atrSlMult > 0) sl = atrPnL(params.atrSlMult);
      } else {
        if (params.takeProfitPct && params.takeProfitPct > 0) {
          tp = +(stake * (params.takeProfitPct / 100)).toFixed(2);
        }
        if (params.stopLossPct && params.stopLossPct > 0) {
          sl = +(stake * (params.stopLossPct / 100)).toFixed(2);
        }
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
      trade = {
        id: randomUUID(),
        contractId: buy.contract_id,
        symbol: params.symbol,
        side: params.side,
        family: "MULTIPLIER",
        contractType,
        stake,
        currency: this.account.currency,
        entrySpot: proposal.spot ?? null,
        exitSpot: null,
        buyPrice: buy.buy_price,
        payout: null,
        multiplier,
        takeProfit: tp ?? null,
        stopLoss: sl ?? null,
        openedAt: Date.now(),
        closedAt: null,
        status: "open",
        profit: null,
        detector: params.detector,
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

    if (info.entry_spot != null && trade.entrySpot == null) trade.entrySpot = info.entry_spot;

    const settled =
      info.is_sold === 1 ||
      info.status === "sold" ||
      info.status === "won" ||
      info.status === "lost";

    if (!settled) {
      this.emit("stateChanged");
      return;
    }

    trade.exitSpot = info.exit_tick ?? trade.exitSpot;
    trade.closedAt = info.sell_time ? info.sell_time * 1000 : Date.now();
    trade.profit = info.profit ?? 0;
    trade.status = info.status === "won" ? "won" : info.status === "lost" ? "lost" : trade.profit >= 0 ? "won" : "lost";

    // Move from open → closed
    this.open = this.open.filter((t) => t.id !== trade.id);
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
