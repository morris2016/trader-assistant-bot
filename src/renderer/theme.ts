export const theme = {
  bg: "#0b0f1a",
  bgPanel: "#12182a",
  border: "#1e2842",
  text: "#e0e5f5",
  textMuted: "#8a95b8",
  textDim: "#6b7390",
  accent: "#5fd4a4",
  danger: "#e05f8a",
  warn: "#d4a35f",
  bull: "#5fd4a4",
  bear: "#e05f8a",
  // Order Block (strong, opaque-ish)
  obBull: "rgba(95, 212, 164, 0.18)",
  obBullBorder: "rgba(95, 212, 164, 0.7)",
  obBear: "rgba(224, 95, 138, 0.18)",
  obBearBorder: "rgba(224, 95, 138, 0.7)",
  // Fair Value Gap (softer, lavender-tinted to visually distinguish)
  fvgBull: "rgba(130, 180, 255, 0.12)",
  fvgBullBorder: "rgba(130, 180, 255, 0.55)",
  fvgBear: "rgba(212, 163, 95, 0.12)",
  fvgBearBorder: "rgba(212, 163, 95, 0.55)",
  // Liquidity pools — bright dashed lines, swept pools fade to muted.
  eqhLine: "rgba(224, 95, 138, 0.9)",   // equal highs — sell-side liquidity (red)
  eqhLineSwept: "rgba(224, 95, 138, 0.35)",
  eqlLine: "rgba(95, 212, 164, 0.9)",   // equal lows  — buy-side liquidity (green)
  eqlLineSwept: "rgba(95, 212, 164, 0.35)",
};
