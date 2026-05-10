# Fast4 User-Defined Probe Patterns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users save and pick custom probe patterns (E/O/B sequences or `WX-OPP-N` / `WX-ALT-N` forms) in the Fast4 panel, persisted alongside the existing registry of named patterns.

**Architecture:** Pattern parsing is centralized in `fast4-patterns.ts` with a new `parsePattern(name)` that handles both registry lookups and arbitrary strings. `Fast4Config` gains a `customPatterns: string[]` field. The Fast4 panel's dropdown surfaces `Registry / My Customs / + Add custom` with a separate "Manage" popover for delete operations.

**Tech Stack:** TypeScript on both bot and web. esbuild bundles the bot; Vite bundles the React renderer. No automated test suite for Fast4 — verification is manual via panel + log inspection.

**Spec:** [docs/superpowers/specs/2026-05-10-fast4-custom-probe-patterns-design.md](../specs/2026-05-10-fast4-custom-probe-patterns-design.md)

---

## File Structure

| File | Responsibility | Operation |
|------|----------------|-----------|
| `src/main/engine/fast4-patterns.ts` | Pattern parser, validator, registry | Modify |
| `src/bot/storage.ts` | `Fast4Config.customPatterns` field + default | Modify |
| `src/bot/index.ts` | Use `parsePattern` for runtime lookup; validate `customPatterns` in `updateFast4Config` | Modify |
| `src/bot/http-server.ts` | Accept `customPatterns` query param (JSON-encoded array) | Modify |
| `src/web/api.ts` | `customPatterns` on `Fast4Config` type | Modify |
| `src/web/panels/Fast4.tsx` | Dropdown groups + add/manage UI | Modify |

---

## Task 1: Add `parsePattern` and `validateProbePattern` to `fast4-patterns.ts`

**Files:**
- Modify: `src/main/engine/fast4-patterns.ts`

- [ ] **Step 1: Add validator function**

In `src/main/engine/fast4-patterns.ts`, after the `FAST4_DEFAULT_PROBE_PATTERN` constant (just before `patternMaxTrades`), insert:

```ts
/** Result of validating a user-supplied probe pattern string. */
export type ProbePatternValidation =
  | { valid: true }
  | { valid: false; reason: string };

const PATTERN_MAX_LENGTH = 25;

/** Validate a user-supplied probe pattern. Accepts either a fixed E/O/B
 *  sequence or a `WX-OPP-N` / `WX-ALT-N` form. Used identically on the
 *  client (live UI feedback) and server (defense). */
export function validateProbePattern(s: string): ProbePatternValidation {
  if (typeof s !== "string" || s.length === 0) {
    return { valid: false, reason: "empty" };
  }
  if (s.length > PATTERN_MAX_LENGTH) {
    return { valid: false, reason: `too long (max ${PATTERN_MAX_LENGTH} chars)` };
  }
  // Reject if it collides with a registry name — registry wins.
  if (FAST4_PROBE_PATTERNS[s]) {
    return { valid: false, reason: "matches a registry name; pick from the registry instead" };
  }
  // Win-exit form
  const wx = s.match(/^WX-(OPP|ALT)-(\d+)$/);
  if (wx) {
    const n = Number(wx[2]);
    if (n < 1 || n > PATTERN_MAX_LENGTH) {
      return { valid: false, reason: `WX maxTrades must be 1-${PATTERN_MAX_LENGTH}` };
    }
    return { valid: true };
  }
  // Fixed sequence
  if (/^[EOB]+$/.test(s)) return { valid: true };
  return { valid: false, reason: "must be E/O/B chars or WX-OPP-N / WX-ALT-N" };
}

/** Resolve a pattern name to its ProbePattern shape. Tries the registry
 *  first; falls back to parsing the string as a raw fixed sequence or
 *  WX-* form. Returns the default pattern when nothing parses. */
export function parsePattern(name: string): ProbePattern {
  const reg = FAST4_PROBE_PATTERNS[name];
  if (reg) return reg;
  const wx = name.match(/^WX-(OPP|ALT)-(\d+)$/);
  if (wx) {
    const n = Number(wx[2]);
    if (n >= 1 && n <= PATTERN_MAX_LENGTH) {
      return { kind: "win-exit", sideRule: wx[1] as "OPP" | "ALT", maxTrades: n };
    }
  }
  if (/^[EOB]+$/.test(name) && name.length >= 1 && name.length <= PATTERN_MAX_LENGTH) {
    return { kind: "fixed", seq: name };
  }
  return FAST4_PROBE_PATTERNS[FAST4_DEFAULT_PROBE_PATTERN];
}
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run typecheck:node 2>&1 | tail -10`

Expected: same pre-existing errors (`fast2-strategies.ts(478,5)`, `fast3-strategies.ts(35,5)`, `fast4-strategies.ts(31,5)` re Granularity, plus two `client.ts` errors). **No new errors involving `fast4-patterns.ts`.**

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/main/engine/fast4-patterns.ts
git commit -m "fast4-patterns: add validateProbePattern + parsePattern

Centralizes pattern resolution so user-supplied strings (custom
patterns) can be parsed identically to registry names. validateProbePattern
returns a {valid, reason} discriminated union for use on both client
(live UI feedback) and server (defense)."
```

---

## Task 2: Add `customPatterns` field to `Fast4Config`

**Files:**
- Modify: `src/bot/storage.ts`

- [ ] **Step 1: Add field to the type**

In `src/bot/storage.ts`, find the `Fast4Config` type definition (block beginning `export type Fast4Config = FastSandboxConfig & {`). Add a `customPatterns` field after `hardCap`:

```ts
  /** Hard cap on ladder advancement (freeze level). 0 = disabled. */
  hardCap: number;
  /** User-saved custom probe patterns. Each entry is a raw pattern
   *  string (fixed E/O/B sequence or WX-OPP-N / WX-ALT-N form) and
   *  appears in the panel's "My Customs" dropdown group. Validated
   *  via fast4-patterns.validateProbePattern(). Capped at 50 entries. */
  customPatterns: string[];
};
```

- [ ] **Step 2: Add field to the default**

In the same file, find `DEFAULT_FAST4_CONFIG`. Add `customPatterns: []` after `hardCap: 0`:

```ts
  martingaleDecay: 0.75,
  probeEnabled: true,
  lossStreakTrigger: 3,
  probePattern: "EBEBE",
  hardCap: 0,
  customPatterns: [],
};
```

- [ ] **Step 3: Backfill on load**

Find the loader (look for the load() method that returns persisted state). Locate the `fast4Config` build block. The block currently spreads defaults and persisted values; we need to ensure `customPatterns` survives existing state files that don't have the field.

The existing block is something like:

```ts
        fast4Config: {
          ...DEFAULT_FAST4_CONFIG,
          ...(parsed.fast4Config ?? {}),
          ...(prefs.fast4Config ?? {}),
          // Force PAPER on every boot — same safety reasoning as Fast2/Fast3.
          liveTradingEnabled: false,
        },
```

The spread already pulls `customPatterns` from defaults when missing, so no change needed unless `prefs.fast4Config.customPatterns` is `null` (would override `[]` to null). Add an explicit fallback:

Replace with:

```ts
        fast4Config: (() => {
          const merged: Fast4Config = {
            ...DEFAULT_FAST4_CONFIG,
            ...(parsed.fast4Config ?? {}),
            ...(prefs.fast4Config ?? {}),
            liveTradingEnabled: false,
          };
          if (!Array.isArray(merged.customPatterns)) merged.customPatterns = [];
          return merged;
        })(),
```

- [ ] **Step 4: Verify the file compiles**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run typecheck:node 2>&1 | tail -10`

Expected: same pre-existing errors only.

- [ ] **Step 5: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/bot/storage.ts
git commit -m "fast4-storage: add customPatterns string[] to Fast4Config

Backfilled on load so existing persisted state without the field
keeps working. Default is empty array."
```

---

## Task 3: Wire `parsePattern` into the bot dispatcher and validate `customPatterns` on update

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Import parsePattern + validator**

Find the existing import line for fast4-patterns (around line 21):

```ts
import { FAST4_PROBE_PATTERNS, FAST4_DEFAULT_PROBE_PATTERN, decideNextTrade as fast4DecideTrade, patternMaxTrades, type ProbePattern } from "../main/engine/fast4-patterns";
```

Replace with:

```ts
import { FAST4_PROBE_PATTERNS, FAST4_DEFAULT_PROBE_PATTERN, decideNextTrade as fast4DecideTrade, patternMaxTrades, parsePattern as fast4ParsePattern, validateProbePattern as fast4ValidatePattern, type ProbePattern } from "../main/engine/fast4-patterns";
```

- [ ] **Step 2: Update fast4PatternFor to use parsePattern**

Find the helper:

```ts
  const fast4PatternFor = (cfg: Fast4Config): ProbePattern => {
    const name = cfg.probePattern || FAST4_DEFAULT_PROBE_PATTERN;
    return FAST4_PROBE_PATTERNS[name] ?? FAST4_PROBE_PATTERNS[FAST4_DEFAULT_PROBE_PATTERN];
  };
```

Replace with:

```ts
  const fast4PatternFor = (cfg: Fast4Config): ProbePattern => {
    const name = cfg.probePattern || FAST4_DEFAULT_PROBE_PATTERN;
    return fast4ParsePattern(name);
  };
```

- [ ] **Step 3: Update probePattern validator in updateFast4Config**

Find this block in the `updateFast4Config` manual-control:

```ts
        // Pattern registry — drop unknown names back to default.
        if (typeof next.probePattern !== "string" || !FAST4_PROBE_PATTERNS[next.probePattern]) {
          next.probePattern = before.probePattern || FAST4_DEFAULT_PROBE_PATTERN;
        }
```

Replace with:

```ts
        // Pattern lookup — accept registry names, valid customs, or any
        // raw string that parses as fixed/WX-*. Reject unparseable strings.
        if (typeof next.probePattern !== "string") {
          next.probePattern = before.probePattern || FAST4_DEFAULT_PROBE_PATTERN;
        } else if (!FAST4_PROBE_PATTERNS[next.probePattern]) {
          // Not a registry name — must validate as custom.
          const v = fast4ValidatePattern(next.probePattern);
          if (!v.valid) {
            log.warn(`fast4Config: rejected probePattern "${next.probePattern}" — ${v.reason}; falling back to ${before.probePattern}`);
            next.probePattern = before.probePattern || FAST4_DEFAULT_PROBE_PATTERN;
          }
        }
```

- [ ] **Step 4: Add customPatterns validator**

Immediately after the hardCap validator block (which ends `next.hardCap = Math.round(next.hardCap);`), insert:

```ts
        // customPatterns: array of validated custom strings, deduped, capped at 50.
        if (!Array.isArray(next.customPatterns)) {
          next.customPatterns = before.customPatterns ?? [];
        } else {
          const seen = new Set<string>();
          const cleaned: string[] = [];
          for (const raw of next.customPatterns) {
            if (typeof raw !== "string") continue;
            if (seen.has(raw)) continue;
            const v = fast4ValidatePattern(raw);
            if (!v.valid) {
              log.warn(`fast4Config: dropping custom "${raw}" — ${v.reason}`);
              continue;
            }
            seen.add(raw);
            cleaned.push(raw);
            if (cleaned.length >= 50) break;
          }
          next.customPatterns = cleaned;
        }
```

- [ ] **Step 5: Build the bot bundle**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run bot:build 2>&1 | tail -5`

Expected:
```
  dist\bot.js  ~561kb

Done in <100ms
```

- [ ] **Step 6: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/bot/index.ts
git commit -m "fast4-bot: route probePattern lookups through parsePattern

Bot now accepts custom strings (validated via fast4ValidatePattern)
in cfg.probePattern, falling back to default with a log warning if
the string is unparseable. Adds a customPatterns[] validator in
updateFast4Config that dedupes, validates each entry, and caps at 50."
```

---

## Task 4: Accept `customPatterns` over HTTP

**Files:**
- Modify: `src/bot/http-server.ts`

- [ ] **Step 1: Add the query-param parser**

Find the block in the `/api/control/update-fast4-config` handler that ends with the `hc` (hardCap) parser:

```ts
            const hc = url.searchParams.get("hardCap");
            if (hc != null && hc !== "") {
              const n = Number(hc);
              if (Number.isFinite(n) && n >= 0) patch.hardCap = Math.round(n);
            }
            if (strategyId) {
```

Insert the customPatterns parser between the `hc` block and the `if (strategyId)`:

```ts
            const hc = url.searchParams.get("hardCap");
            if (hc != null && hc !== "") {
              const n = Number(hc);
              if (Number.isFinite(n) && n >= 0) patch.hardCap = Math.round(n);
            }
            const cps = url.searchParams.get("customPatterns");
            if (cps != null && cps !== "") {
              try {
                const parsed = JSON.parse(cps);
                if (Array.isArray(parsed)) {
                  patch.customPatterns = parsed.filter((x: unknown): x is string => typeof x === "string");
                }
              } catch {
                // Bad JSON — ignore the field, server-side validator will keep current value.
              }
            }
            if (strategyId) {
```

- [ ] **Step 2: Verify build**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run bot:build 2>&1 | tail -3`

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/bot/http-server.ts
git commit -m "fast4-http: accept customPatterns query param (JSON array)

Parsed and forwarded to manualControls.updateFast4Config, which does
the actual validation/dedup/cap."
```

---

## Task 5: Add `customPatterns` to the web API client type

**Files:**
- Modify: `src/web/api.ts`

- [ ] **Step 1: Update the type**

Find the `Fast4Config` type (after `Fast3Config`):

```ts
export type Fast4Config = FastSandboxConfig & {
  probeEnabled: boolean;
  lossStreakTrigger: number;
  /** Named probe pattern (see Fast4 panel dropdown values). */
  probePattern: string;
  /** Hard cap on ladder advancement (freeze level). 0 = disabled. */
  hardCap: number;
};
```

Replace with:

```ts
export type Fast4Config = FastSandboxConfig & {
  probeEnabled: boolean;
  lossStreakTrigger: number;
  /** Named probe pattern (see Fast4 panel dropdown values). May be a
   *  registry name OR an entry from `customPatterns`. */
  probePattern: string;
  /** Hard cap on ladder advancement (freeze level). 0 = disabled. */
  hardCap: number;
  /** User-saved custom probe patterns (raw strings). */
  customPatterns: string[];
};
```

- [ ] **Step 2: Patch the `updateFast4Config` client to JSON-encode the array**

Find `updateFast4Config: (patch: Partial<Fast4Config>) => {` and inspect the loop. The current implementation iterates entries and stringifies primitives, but arrays will fall through. Add a special case:

Locate this block:

```ts
  updateFast4Config: (patch: Partial<Fast4Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "perStrategy") continue;
      if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast4-config?${p.toString()}`);
  },
```

Replace with:

```ts
  updateFast4Config: (patch: Partial<Fast4Config>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(patch)) {
      if (k === "perStrategy") continue;
      if (Array.isArray(v)) p.set(k, JSON.stringify(v));
      else if (typeof v === "boolean") p.set(k, String(v));
      else if (typeof v === "string") p.set(k, v);
      else if (v != null && Number.isFinite(v as number)) p.set(k, String(v));
    }
    return post<{ ok: boolean }>(`/api/control/update-fast4-config?${p.toString()}`);
  },
```

- [ ] **Step 3: Verify**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run typecheck:web 2>&1 | tail -10`

Expected: same pre-existing `live/index.tsx` ContractFamily error only.

- [ ] **Step 4: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/web/api.ts
git commit -m "fast4-api: customPatterns on Fast4Config; JSON-encode arrays

URLSearchParams loop in updateFast4Config now JSON-stringifies array
fields so customPatterns[] makes it across the wire."
```

---

## Task 6: Fast4 panel UI — extend dropdown and add manage popover

**Files:**
- Modify: `src/web/panels/Fast4.tsx`

This is the biggest task. Break it into sub-steps.

- [ ] **Step 1: Import the validator**

At the top of `Fast4.tsx`, add an import next to the existing imports:

```tsx
import { validateProbePattern as validatePatternFn } from "../../main/engine/fast4-patterns";
```

(Adjust the relative path if needed — `Fast4.tsx` is at `src/web/panels/`, the engine file is at `src/main/engine/`. Use `"../../main/engine/fast4-patterns"`.)

- [ ] **Step 2: Add local state for the inline add input + manage popover**

Find the existing useState block at the top of the `Fast4Panel` component:

```tsx
  const [paper, setPaper] = useState<Fast4PaperResp | null>(null);
  const [paperTrades, setPaperTrades] = useState<ClosedPaperPosition[]>([]);
  const [equity, setEquity] = useState<EquityPoint[]>([]);
  const [strategies, setStrategies] = useState<StrategyStats[]>([]);
  const [martingale, setMartingale] = useState<Record<string, FastMartingaleSnapshot>>({});
  const [liveTrades, setLiveTrades] = useState<RealTrade[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resetTo, setResetTo] = useState<string>("41");
  const [pendingCfg, setPendingCfg] = useState<Fast4Config | null>(null);
```

Add three state hooks after `pendingCfg`:

```tsx
  const [pendingCfg, setPendingCfg] = useState<Fast4Config | null>(null);
  const [addingCustom, setAddingCustom] = useState<boolean>(false);
  const [customDraft, setCustomDraft] = useState<string>("");
  const [showManage, setShowManage] = useState<boolean>(false);
```

- [ ] **Step 3: Update the dirty-check to include customPatterns**

Find the `dirty` const:

```tsx
  const dirty = pendingCfg !== null && (
    pendingCfg.martingaleMultiplier !== paper.config.martingaleMultiplier ||
    ...
    (pendingCfg.probePattern ?? "EBEBE") !== (paper.config.probePattern ?? "EBEBE") ||
    (pendingCfg.hardCap ?? 0) !== (paper.config.hardCap ?? 0)
  );
```

Add a `customPatterns` comparison at the end (use JSON.stringify for array equality):

```tsx
  const dirty = pendingCfg !== null && (
    pendingCfg.martingaleMultiplier !== paper.config.martingaleMultiplier ||
    pendingCfg.baseStake !== paper.config.baseStake ||
    pendingCfg.maxLevels !== paper.config.maxLevels ||
    pendingCfg.perTradeCap !== paper.config.perTradeCap ||
    pendingCfg.sideFilter !== paper.config.sideFilter ||
    pendingCfg.martingaleMode !== paper.config.martingaleMode ||
    pendingCfg.liveTradingEnabled !== paper.config.liveTradingEnabled ||
    (pendingCfg.martingaleDecay ?? 1) !== (paper.config.martingaleDecay ?? 1) ||
    pendingCfg.probeEnabled !== paper.config.probeEnabled ||
    pendingCfg.lossStreakTrigger !== paper.config.lossStreakTrigger ||
    (pendingCfg.probePattern ?? "EBEBE") !== (paper.config.probePattern ?? "EBEBE") ||
    (pendingCfg.hardCap ?? 0) !== (paper.config.hardCap ?? 0) ||
    JSON.stringify(pendingCfg.customPatterns ?? []) !== JSON.stringify(paper.config.customPatterns ?? [])
  );
```

- [ ] **Step 4: Replace the existing Probe Pattern ConfigField**

Find the existing dropdown:

```tsx
          <ConfigField label="Probe Pattern (the recipe to fire when triggered)">
            <select
              className="filter-select"
              value={cfg.probePattern || "EBEBE"}
              onChange={(e) => setCfg({ probePattern: e.target.value })}
              title="..."
            >
              {PROBE_PATTERN_GROUPS.map((group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                </optgroup>
              ))}
            </select>
          </ConfigField>
```

Replace with the new version that includes My Customs + manage:

```tsx
          <ConfigField label="Probe Pattern (the recipe to fire when triggered)">
            <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
              <select
                className="filter-select"
                style={{ flex: 1 }}
                value={cfg.probePattern || "EBEBE"}
                onChange={(e) => {
                  if (e.target.value === "__ADD_CUSTOM__") {
                    setAddingCustom(true);
                    setCustomDraft("");
                    return;
                  }
                  setCfg({ probePattern: e.target.value });
                }}
                title="Named probe pattern. E = opposite digit, O/B = base digit. WX-OPP-N = keep firing opposite until win or N trades. WX-ALT-N = alternate."
              >
                {PROBE_PATTERN_GROUPS.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                  </optgroup>
                ))}
                {(cfg.customPatterns ?? []).length > 0 && (
                  <optgroup label="My Customs">
                    {(cfg.customPatterns ?? []).map((opt) => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="Custom">
                  <option value="__ADD_CUSTOM__">+ Add custom…</option>
                </optgroup>
              </select>
              {(cfg.customPatterns ?? []).length > 0 && (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  style={{ padding: "0 8px" }}
                  onClick={() => setShowManage(true)}
                  title="Manage saved custom patterns"
                >
                  ⋯
                </button>
              )}
            </div>
            {addingCustom && (() => {
              const draft = customDraft.toUpperCase();
              const v = validatePatternFn(draft);
              const isDuplicate = (cfg.customPatterns ?? []).includes(draft);
              const canSave = v.valid && !isDuplicate;
              const reason = v.valid
                ? (isDuplicate ? "already saved" : "")
                : (v as { valid: false; reason: string }).reason;
              return (
                <div style={{ marginTop: 6, display: "flex", gap: 4, alignItems: "center" }}>
                  <input
                    className="filter-input"
                    style={{
                      flex: 1,
                      borderColor: draft.length === 0 ? undefined : (canSave ? "#3a8" : "#a33"),
                    }}
                    value={draft}
                    autoFocus
                    placeholder="e.g. EOOEEEOO or WX-OPP-25"
                    onChange={(e) => setCustomDraft(e.target.value.toUpperCase())}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSave) {
                        const next = [...(cfg.customPatterns ?? []), draft];
                        setCfg({ customPatterns: next, probePattern: draft });
                        setAddingCustom(false);
                        setCustomDraft("");
                      }
                      if (e.key === "Escape") {
                        setAddingCustom(false);
                        setCustomDraft("");
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    disabled={!canSave}
                    onClick={() => {
                      const next = [...(cfg.customPatterns ?? []), draft];
                      setCfg({ customPatterns: next, probePattern: draft });
                      setAddingCustom(false);
                      setCustomDraft("");
                    }}
                  >
                    save
                  </button>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => { setAddingCustom(false); setCustomDraft(""); }}
                  >
                    cancel
                  </button>
                  {draft.length > 0 && reason && (
                    <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>{reason}</span>
                  )}
                </div>
              );
            })()}
          </ConfigField>
```

- [ ] **Step 5: Add the Manage popover**

Below the entire Configuration card (after the closing `</div>` of `<div className="card" style={{ marginBottom: 16, padding: 16 }}>`), insert a small manage modal that conditionally renders:

```tsx
      {showManage && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 50,
          }}
          onClick={() => setShowManage(false)}
        >
          <div
            className="card"
            style={{ minWidth: 360, maxWidth: 480, padding: 16 }}
            onClick={(e) => e.stopPropagation()}
          >
            <h4 style={{ marginTop: 0, marginBottom: 12 }}>Manage Custom Patterns</h4>
            {(cfg.customPatterns ?? []).length === 0 ? (
              <div className="muted">No custom patterns saved.</div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {(cfg.customPatterns ?? []).map((pat) => (
                  <div key={pat} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span className="mono" style={{ flex: 1 }}>{pat}</span>
                    <button
                      type="button"
                      className="btn btn-warn btn-sm"
                      onClick={() => {
                        const next = (cfg.customPatterns ?? []).filter((p) => p !== pat);
                        const patch: Partial<Fast4Config> = { customPatterns: next };
                        if (cfg.probePattern === pat) patch.probePattern = "EBEBE";
                        setCfg(patch);
                      }}
                      title="Delete this custom pattern"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 12 }}>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => setShowManage(false)}
              >
                close
              </button>
            </div>
          </div>
        </div>
      )}
```

- [ ] **Step 6: Build the web bundle**

Run: `cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop" && npm run web:build 2>&1 | tail -8`

Expected:
```
✓ 48 modules transformed.
rendering chunks...
computing gzip size...
../../dist/web/index.html              ...
../../dist/web/assets/index-*.css      ...
../../dist/web/assets/index-*.js       ...
✓ built in <2s
```

- [ ] **Step 7: Manual verification**

Spec verification checklist (complete each):

```
[ ] Open the Fast4 tab in the running web UI
[ ] Dropdown shows registry options as before
[ ] Select "+ Add custom…" → input appears below the dropdown
[ ] Type "EOOEEEOOEE" → green border, save enabled
[ ] Type "XYZ" → red border, save disabled, reason text shows
[ ] Type "WX-OPP-30" → red border (max 25), reason shows
[ ] Type "WX-OPP-25" → green border, save enabled
[ ] Type "EBEBE" (registry name) → red border, "matches a registry name" reason
[ ] Save a valid custom → appears under "My Customs" group, becomes selected
[ ] After save, click apply → no errors, custom persists across page reload
[ ] Click ⋯ button → manage popover opens with the saved pattern
[ ] Click × in manage popover → pattern disappears
[ ] If the deleted pattern was selected, probePattern auto-resets to "EBEBE"
[ ] Click outside the popover → closes
```

- [ ] **Step 8: Commit**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git add src/web/panels/Fast4.tsx
git commit -m "fast4-panel: dropdown supports custom patterns + manage popover

The probe-pattern dropdown gains a 'My Customs' group (when non-empty)
and a final '+ Add custom…' entry. Selecting Add reveals an inline
text input with live validation (green/red border, error reason).
Save appends to customPatterns and selects the new pattern.

A ⋯ button next to the dropdown opens a modal listing saved customs
with × delete buttons. Deleting the active pattern resets probePattern
to the default EBEBE."
```

---

## Task 7: Push

- [ ] **Step 1: Push everything to origin**

```bash
cd "C:/Users/fame/Documents/bin/Desktop apps/trader-assistant-desktop"
git push 2>&1 | tail -5
```

Expected output ends with:
```
   <prevhash>..<newhash>  main -> main
```

---

## Self-Review Notes

- **Spec coverage:** All 6 files in the spec are covered (Tasks 1–6); HTTP route, validator, parser, panel, type, persistence all addressed. The "auto-uppercase on input" rule from the spec is enforced in Task 6 Step 4 via `e.target.value.toUpperCase()`. The 50-entry cap is enforced server-side in Task 3 Step 4.
- **Placeholder scan:** No TBDs/TODOs. All steps contain complete code.
- **Type consistency:** `validateProbePattern` returns `{ valid: true } | { valid: false; reason: string }` consistently across Tasks 1, 3, 6. `customPatterns` is `string[]` everywhere.
- **Spec ambiguity check:** "Manage popover" is implemented as a portal modal (Task 6 Step 5) per the spec's stated decision.
- **Path verification:** Fast4.tsx imports the engine module at `"../../main/engine/fast4-patterns"`. Confirmed by inspecting `src/web/panels/Fast4.tsx` location and existing imports.
