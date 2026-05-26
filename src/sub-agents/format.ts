/**
 * Display-format helpers for sub-agent renderers.
 *
 * Pure functions — no I/O, no theme dependency. Tested independently.
 */

/** Braille spinner frames. 10-frame cycle pairs naturally with 100ms tick. */
export const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Tick interval for spinner animation. Also drives renderResult invalidate cadence. */
export const SPINNER_TICK_MS = 100;

/**
 * Resolve the current spinner frame from wall-clock time.
 *
 * Computing from `Date.now()` (rather than a counter) means we don't need
 * to thread a frame-index through render state, and parallel delegations
 * stay visually in-sync.
 */
export function getSpinnerFrame(now: number = Date.now()): string {
  const len = SPINNER_FRAMES.length;
  // Math.max guards against negative inputs (JS `%` would yield -1…-9 and
  // out-of-bounds indexing returns undefined). Date.now() never produces this
  // but the API is public and tested with arbitrary numbers.
  const safe = Math.max(0, now);
  return SPINNER_FRAMES[Math.floor(safe / SPINNER_TICK_MS) % len];
}

/**
 * Format a USD cost with progressive precision:
 * - `< $0.001`  → `<$0.001` (rounds-to-zero territory)
 * - `< $1`      → `$0.004`, `$0.420` (3 decimal places for sub-dollar)
 * - `< $100`    → `$1.23`, `$42.05` (cents)
 * - otherwise   → `$123` (whole dollars; rare for a single delegation)
 *
 * Thresholds use `0.9995` / `99.995` instead of `1` / `100` so values that
 * would round up to the next tier's display string (e.g. `99.999` → `100.00`)
 * are bucketed into the next tier directly instead of producing the visually
 * inconsistent `$100.00`.
 */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return "$0";
  if (usd < 0.001) return "<$0.001";
  if (usd < 0.9995) return `$${usd.toFixed(3)}`;
  if (usd < 99.995) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(0)}`;
}

/**
 * Truncate a path-like string to fit within `max` characters while keeping
 * the most informative tail (filename and a parent or two).
 *
 * Strategy:
 * 1. If short enough, return unchanged.
 * 2. Try progressively fewer leading segments, prefixing `…/` until it fits.
 *    e.g. `/a/b/c/d/file.ts` → `…/c/d/file.ts` → `…/d/file.ts` → `…/file.ts`.
 * 3. If even the basename is too long, truncate the basename from the LEFT.
 *    Keeping the suffix visible matters more than the prefix because the
 *    extension and trailing chars usually disambiguate the file.
 *
 * `max` is the visible-character budget; the `…` glyph counts as 1.
 */
export function truncatePath(p: string, max: number): string {
  if (max <= 0) return "";
  if (max < 2) return p.slice(-max);
  if (p.length <= max) return p;
  const parts = p.split("/").filter((s) => s.length > 0);
  for (let n = parts.length - 1; n >= 1; n--) {
    const candidate = `…/${parts.slice(-n).join("/")}`;
    if (candidate.length <= max) return candidate;
  }
  const base = parts[parts.length - 1] ?? p;
  return `…${base.slice(base.length - (max - 1))}`;
}

/**
 * Format a millisecond duration with progressive precision.
 *
 * - `< 1ms`   → `<1ms`
 * - `< 1s`    → `47ms`, `200ms`
 * - `< 60s`   → `3.2s`
 * - `< 1h`    → `2m 7s`
 * - otherwise → `1h 12m`
 *
 * Replaces the previous flat `${(ms/1000).toFixed(1)}s` formatter which
 * displayed every sub-second tool as `0.0s` and grew unwieldy past one
 * minute (e.g. `127.4s`).
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0ms";
  if (ms < 1) return "<1ms";
  // Bucket AFTER rounding so values like 999.6 don't render as "1000ms":
  // 999.6 → Math.round → 1000 → falls through to the seconds branch → "1.0s".
  const roundedMs = Math.round(ms);
  if (roundedMs < 1000) return `${roundedMs}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3_600_000) {
    const m = Math.floor(ms / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${m}m ${s}s`;
  }
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h ${m}m`;
}
