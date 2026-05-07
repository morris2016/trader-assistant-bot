// Fast4 probe-pattern registry.
//
// Each pattern is a named recipe for what side to bet during a probe phase
// (after the loss-streak trigger fires). Two families:
//
//   "fixed"     — a fixed-length sequence of E (opposite) / O (base) / B (base)
//                 letters. The phase runs for exactly seq.length trades.
//                 E.g. "EBEBE" = 5 trades alternating E/B.
//   "win-exit"  — keep firing the chosen side until a win lands (early-exit)
//                 or maxTrades is reached. Side rule:
//                   "OPP" — every probe trade is opposite of base
//                   "ALT" — alternate opposite/base each trade
//
// Letter semantics (when base is ODD):
//   E = EVEN  (opposite of base)         → counted as "probe" trade
//   O = ODD   (base side)                → counted as "interleave" base trade
//   B = ODD   (explicit base)            → same as O, just clearer in EBEBE-style names
//
// Streak counter (`baseLossStreak`) only advances on TRUE NORMAL base trades
// (i.e., trades fired when not in any phase). Interleaved base trades inside
// a phase do NOT count toward the streak.

export type ProbePatternKind = "fixed" | "win-exit";

export type FixedProbePattern = {
  kind: "fixed";
  /** Sequence of letters (E / O / B). Phase runs for exactly seq.length trades. */
  seq: string;
};

export type WinExitProbePattern = {
  kind: "win-exit";
  /** Side selection rule per phaseIdx. "OPP" = always opposite. "ALT" = alternate. */
  sideRule: "OPP" | "ALT";
  /** Hard cap on phase length — phase ends after this many trades regardless of outcome. */
  maxTrades: number;
};

export type ProbePattern = FixedProbePattern | WinExitProbePattern;

/** Master registry — names here become the dropdown values in the UI. */
export const FAST4_PROBE_PATTERNS: Record<string, ProbePattern> = {
  // Disabled — emits no probe at all (acts like Fast3).
  "OFF": { kind: "fixed", seq: "" },

  // Short fixed sequences
  "EE":           { kind: "fixed", seq: "EE" },
  "EO":           { kind: "fixed", seq: "EO" },
  "EOE":          { kind: "fixed", seq: "EOE" },
  "EEE":          { kind: "fixed", seq: "EEE" },
  "EEEE":         { kind: "fixed", seq: "EEEE" },
  "EOEO":         { kind: "fixed", seq: "EOEO" },
  "EBEBE":        { kind: "fixed", seq: "EBEBE" },     // current deployed default
  "EEEEE":        { kind: "fixed", seq: "EEEEE" },
  "EOEOE":        { kind: "fixed", seq: "EOEOE" },

  // Length-6 (user-suggested + controls)
  "EEEEEE":       { kind: "fixed", seq: "EEEEEE" },
  "EOEOEO":       { kind: "fixed", seq: "EOEOEO" },
  "EOOEEO":       { kind: "fixed", seq: "EOOEEO" },
  "EOEEOE":       { kind: "fixed", seq: "EOEEOE" },
  "EEEOE":        { kind: "fixed", seq: "EEEOE" },
  "EOOOEE":       { kind: "fixed", seq: "EOOOEE" },

  // Length-7+
  "EEEEEEE":      { kind: "fixed", seq: "EEEEEEE" },
  "EOEOEOE":      { kind: "fixed", seq: "EOEOEOE" },

  // Win-exit family
  "WX-OPP-3":     { kind: "win-exit", sideRule: "OPP", maxTrades: 3 },
  "WX-OPP-5":     { kind: "win-exit", sideRule: "OPP", maxTrades: 5 },
  "WX-OPP-7":     { kind: "win-exit", sideRule: "OPP", maxTrades: 7 },
  "WX-OPP-10":    { kind: "win-exit", sideRule: "OPP", maxTrades: 10 },
  "WX-OPP-15":    { kind: "win-exit", sideRule: "OPP", maxTrades: 15 },
  "WX-ALT-5":     { kind: "win-exit", sideRule: "ALT", maxTrades: 5 },
  "WX-ALT-10":    { kind: "win-exit", sideRule: "ALT", maxTrades: 10 },
};

export const FAST4_PROBE_PATTERN_NAMES = Object.keys(FAST4_PROBE_PATTERNS);

export const FAST4_DEFAULT_PROBE_PATTERN = "EBEBE";

/** Total trades in this phase (length cap). For win-exit patterns this is
 *  the upper bound; the phase may end earlier on a win. */
export function patternMaxTrades(pat: ProbePattern): number {
  return pat.kind === "fixed" ? pat.seq.length : pat.maxTrades;
}

export type PhaseDecision = {
  /** Phase trade kind, used by settle handler:
   *    probe       — opposite side; doesn't count toward streak
   *    interleave  — base side inside phase; doesn't count toward streak
   *    exit        — phase has ended; this is a normal base trade
   *    normal      — no phase active */
  kind: "normal" | "probe" | "interleave" | "exit";
  /** Which digit side to bet on this trade. */
  side: "DIGITODD" | "DIGITEVEN";
};

/** Decide the next trade given current probe-phase state and the pattern.
 *  baseSide is the strategy's normal side (DIGITODD by default).
 *  inPhase=false → "normal" kind, base side.
 *  inPhase=true  → consult pattern[phaseIdx]; "exit" kind if pattern is exhausted. */
export function decideNextTrade(args: {
  inPhase: boolean;
  phaseIdx: number;
  phaseHadWin: boolean;
  pattern: ProbePattern;
  baseSide: "DIGITODD" | "DIGITEVEN";
}): PhaseDecision {
  const { inPhase, phaseIdx, phaseHadWin, pattern, baseSide } = args;
  const opposite: "DIGITODD" | "DIGITEVEN" = baseSide === "DIGITODD" ? "DIGITEVEN" : "DIGITODD";

  if (!inPhase) return { kind: "normal", side: baseSide };

  const maxTrades = patternMaxTrades(pattern);

  // Phase exhausted → exit (this trade fires as normal base).
  if (phaseIdx >= maxTrades) return { kind: "exit", side: baseSide };

  // Win-exit early termination: if a win has already landed in this phase,
  // exit immediately on the next decision (this trade is normal base).
  if (pattern.kind === "win-exit" && phaseHadWin) return { kind: "exit", side: baseSide };

  if (pattern.kind === "fixed") {
    const ch = pattern.seq[phaseIdx];
    if (ch === "E") return { kind: "probe", side: opposite };
    // O or B = base side
    return { kind: "interleave", side: baseSide };
  }

  // Win-exit: still firing.
  if (pattern.sideRule === "OPP") {
    return { kind: "probe", side: opposite };
  }
  // ALT — alternate starting with opposite at phaseIdx=0.
  const sidePick: "DIGITODD" | "DIGITEVEN" = phaseIdx % 2 === 0 ? opposite : baseSide;
  return { kind: sidePick === opposite ? "probe" : "interleave", side: sidePick };
}
