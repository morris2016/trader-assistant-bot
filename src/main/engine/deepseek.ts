import { randomUUID } from "node:crypto";
import { latestAtr, latestRegime } from "./indicators";
import type { Candle, OrderBlock, Signal, SymbolCode } from "@shared/types";

/**
 * DeepSeek-driven primary signal generator.
 *
 * Called on every new bar close (with a cooldown). Sends the recent OHLC
 * tape plus structural context (active OBs, ATR, ADX) to deepseek-chat and
 * parses a strict JSON response. Returns a Signal when the model picks
 * BUY/SELL above the configured confidence threshold; otherwise null.
 *
 * Fails closed: any network/parse error → null, no trade fires.
 */

const DEEPSEEK_URL = "https://api.deepseek.com/v1/chat/completions";
const MODEL = "deepseek-chat";
const COOLDOWN_MS = 30_000;
const REQUEST_TIMEOUT_MS = 25_000;
const RECENT_BARS = 30;

type Advice = {
  action: "BUY" | "SELL" | "HOLD";
  confidence: number; // 0..1
  reason: string;
};

export type AdvisorContext = {
  symbol: SymbolCode;
  candles: Candle[];
  activeOrderBlocks: OrderBlock[];
  apiKey: string;
  /** Minimum confidence to emit BUY/SELL. Below this → null. */
  minConfidence?: number;
};

let lastCallAtMs = 0;
let lastAdvice: { advice: Advice; symbol: SymbolCode; tsMs: number } | null = null;
let inflight = false;

export function getLastAdvice() {
  return lastAdvice;
}

export function clearAdvisorCooldown() {
  lastCallAtMs = 0;
  lastAdvice = null;
}

export async function maybeAdvise(ctx: AdvisorContext): Promise<Signal | null> {
  if (!ctx.apiKey) return null;
  if (inflight) return null;
  const now = Date.now();
  if (now - lastCallAtMs < COOLDOWN_MS) return null;
  if (ctx.candles.length < RECENT_BARS) return null;
  lastCallAtMs = now;

  inflight = true;
  try {
    const advice = await callDeepseek(ctx);
    if (!advice) return null;
    lastAdvice = { advice, symbol: ctx.symbol, tsMs: Date.now() };

    const minConf = ctx.minConfidence ?? 0.55;
    if (advice.action === "HOLD") return null;
    if (advice.confidence < minConf) return null;

    const last = ctx.candles[ctx.candles.length - 1];
    const signal: Signal = {
      id: randomUUID(),
      ts: Date.now(),
      symbol: ctx.symbol,
      detector: "deepseek",
      action: advice.action,
      confidence: advice.confidence,
      reason: `DeepSeek: ${advice.reason}`,
      price: last.close,
    };
    return signal;
  } catch (err) {
    console.error("[deepseek] advise failed", err);
    return null;
  } finally {
    inflight = false;
  }
}

/**
 * Stateless DeepSeek call — no cooldown, no shared state. Used by the
 * backtest engine which orchestrates its own cadence and concurrency.
 */
export async function inferAdvice(ctx: AdvisorContext): Promise<Advice | null> {
  if (!ctx.apiKey) return null;
  if (ctx.candles.length < RECENT_BARS) return null;
  return callDeepseek(ctx);
}

async function callDeepseek(ctx: AdvisorContext): Promise<Advice | null> {
  const candles = ctx.candles.slice(-RECENT_BARS);
  const last = candles[candles.length - 1];
  const atr = latestAtr(ctx.candles, 14);
  const regime = latestRegime(ctx.candles, 22, 14);

  const tape = candles
    .map((c, i) => `${i}: O=${c.open} H=${c.high} L=${c.low} C=${c.close}`)
    .join("\n");

  const obs = ctx.activeOrderBlocks
    .slice(0, 6)
    .map((b) => `- ${b.side} OB ${b.bottom.toFixed(5)}–${b.top.toFixed(5)}`)
    .join("\n") || "(none)";

  const prompt = [
    "You are a price-action trader. Analyze the recent OHLC bars and structural context",
    "for a single instrument and emit ONE JSON object only:",
    `{"action": "BUY" | "SELL" | "HOLD", "confidence": 0.0..1.0, "reason": "<one short sentence>"}`,
    "",
    "Rules:",
    "- Be conservative. Prefer HOLD when the tape is choppy, the trend is unclear,",
    "  or volatility (ATR) is unusually high relative to recent bars.",
    "- BUY only on bullish structure: higher highs/lows, trend with momentum,",
    "  or a clean rejection from a bullish Order Block.",
    "- SELL is the mirror.",
    "- Do not output anything outside the JSON object.",
    "",
    `Symbol: ${ctx.symbol}`,
    `Last close: ${last.close}`,
    `ATR(14): ${atr.toFixed(6)}`,
    `ADX(14): ${regime.adx.toFixed(2)} (${regime.trending ? `trending ${regime.direction}` : "ranging"})`,
    `Active Order Blocks:\n${obs}`,
    "",
    `Recent ${candles.length} bars (oldest → newest):`,
    tape,
  ].join("\n");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${ctx.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.2,
        max_tokens: 120,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      console.warn(`[deepseek] http ${res.status}`);
      return null;
    }
    const json = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const text = json.choices?.[0]?.message?.content ?? "";
    if (!text) return null;
    const parsed = JSON.parse(text) as Partial<Advice>;
    const action = (parsed.action ?? "HOLD").toString().toUpperCase();
    if (action !== "BUY" && action !== "SELL" && action !== "HOLD") return null;
    const confidence = Math.max(0, Math.min(1, Number(parsed.confidence ?? 0)));
    const reason = String(parsed.reason ?? "").slice(0, 200);
    return { action: action as Advice["action"], confidence, reason };
  } finally {
    clearTimeout(timer);
  }
}
