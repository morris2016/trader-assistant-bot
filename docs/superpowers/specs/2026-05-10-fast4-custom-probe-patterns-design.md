# Fast4 — User-defined probe patterns

**Date:** 2026-05-10
**Status:** Approved, ready for implementation

## Problem

The Fast4 panel's probe-pattern dropdown is limited to a fixed registry of
25 named patterns (`EBEBE`, `WX-OPP-10`, `EOOEEO`, etc.). The user needs
to define their own patterns — fixed sequences of E/O/B letters or
`WX-OPP-N` / `WX-ALT-N` win-exit forms with arbitrary N — and have them
persist across restarts.

## Solution

Customs are flat strings stored in `Fast4Config.customPatterns: string[]`.
The pattern string IS its identifier; no separate naming step. The
dropdown shows registry patterns + saved customs + an "Add custom" entry.
The bot's pattern parser is extended to handle arbitrary strings via the
same matchers it already uses for registry entries.

## Schema

`Fast4Config` gains:

```ts
customPatterns: string[];  // default []
```

`probePattern` (existing field) continues to hold the active pattern. It
may now be either a registry name or any string in `customPatterns`.

## Pattern parser (`fast4-patterns.ts`)

```ts
function parsePattern(name: string): ProbePattern {
  // 1. Registry lookup
  if (FAST4_PROBE_PATTERNS[name]) return FAST4_PROBE_PATTERNS[name];

  // 2. WX-OPP-N or WX-ALT-N
  const wx = name.match(/^WX-(OPP|ALT)-(\d+)$/);
  if (wx) {
    const n = Number(wx[2]);
    if (n >= 1 && n <= 25) return { kind: "win-exit", sideRule: wx[1], maxTrades: n };
  }

  // 3. Fixed E/O/B sequence
  if (/^[EOB]+$/.test(name) && name.length >= 1 && name.length <= 25) {
    return { kind: "fixed", seq: name };
  }

  // 4. Fallback — log warning, return default
  return FAST4_PROBE_PATTERNS[FAST4_DEFAULT_PROBE_PATTERN];
}
```

A separate `validateProbePattern(s: string): { valid: boolean; reason?: string }`
is also exported for client-side use (so the UI can render red/green
borders without re-implementing the rules).

## Validation rules (client + server)

- Length 1–25 chars
- Either `^[EOB]+$` OR `^WX-(OPP|ALT)-(\d+)$` (numeric N must be 1–25)
- The text input auto-uppercases on every keystroke so users don't have
  to remember case (lowercase `eoeo` becomes `EOEO`)
- Duplicate of registry name → rejected (registry wins)
- Duplicate of existing custom → no-op (deduped on save)

## UI behavior

Dropdown shows three groups:

1. **Registry** — the 25 named patterns from `FAST4_PROBE_PATTERNS`,
   organized by family (existing `PROBE_PATTERN_GROUPS`)
2. **My Customs** — entries from `customPatterns[]`, only rendered when
   the array is non-empty
3. **+ Add custom** — final entry; selecting it reveals an inline text
   input below the dropdown

Add-custom flow:
- Text input with placeholder `"e.g. EOOEEEOO or WX-OPP-25"`
- Live validation: green border when `validateProbePattern(s).valid`,
  red border with a small error label otherwise
- **Save** button (disabled when invalid or duplicate); on click:
  - Append to `customPatterns[]`
  - Set `probePattern` to the new string
  - Send to server via `updateFast4Config` (single round-trip carrying
    both fields)
  - Hide the input

Delete-custom flow:
- Each "My Customs" entry has a small **×** affordance (rendered as a
  separate button next to the dropdown, since `<select>` options can't
  hold inline buttons in a portable way)
- Or simpler: a "Manage customs" link below the dropdown that opens a
  small list with delete buttons per entry
- Decision: **Manage button + popover list** — keeps the dropdown clean
  and avoids fighting native `<select>` rendering

## Persistence

`customPatterns` is saved as part of `Fast4Config` in both `bot-state.json`
and the `bot-prefs.json` sidecar — same path as every other Fast4 knob.
Survives Railway redeploy, container restart, and the existing
`resetFast4Paper` operation (config is preserved on paper-reset).

## HTTP route

`/api/control/update-fast4-config` accepts a new `customPatterns` query
parameter. Since arrays don't fit cleanly in query params, encode as a
JSON-stringified array (e.g. `customPatterns=%5B%22EOOEEO%22%2C%22WX-OPP-25%22%5D`).
The server parses with `JSON.parse`, validates each entry via
`validateProbePattern`, dedupes against the registry and itself, and
caps the list size at 50 to prevent unbounded growth.

## Files to change

1. `src/main/engine/fast4-patterns.ts` — add `parsePattern`, `validateProbePattern`
2. `src/bot/storage.ts` — add `customPatterns: string[]` to `Fast4Config`
3. `src/bot/index.ts` — replace direct `FAST4_PROBE_PATTERNS[cfg.probePattern]`
   lookup with `parsePattern(cfg.probePattern)`; add `customPatterns` validator
4. `src/bot/http-server.ts` — accept `customPatterns` query param
5. `src/web/api.ts` — add `customPatterns` to `Fast4Config` type
6. `src/web/panels/Fast4.tsx` — extend dropdown with custom group + add/delete UI

## Out of scope

- Naming saved patterns (the string IS the name)
- Importing/exporting pattern lists
- Per-strategy custom patterns (`customPatterns` is sandbox-wide)
- Re-running historical sims when a custom pattern is selected (would
  need a separate "test pattern" feature)

## Testing

Manual verification only — Fast4 has no automated tests. Verification
checklist:

- Add a valid fixed pattern (e.g. `EOEOEOOO`) → appears in dropdown
- Add a valid win-exit (e.g. `WX-OPP-25`) → appears in dropdown
- Add invalid pattern (e.g. `XYZ`, `EE!`, length 30) → save button disabled
- Add duplicate (registry name or existing custom) → no-op
- Delete a custom → disappears from dropdown
- Reload UI → custom patterns persist
- Bot restart → custom patterns persist
- Bot dispatch with custom pattern selected → fires correct sequence
  (verify via paper trades + log lines)
- Falling back: set `probePattern` to invalid string via API → bot logs
  warning, uses default
