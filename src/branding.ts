/**
 * Branding widget — renders a gradient "✦ Bytes ✦" right-aligned above
 * the chat input editor.
 *
 * Uses fixed 24-bit RGB colors so the look is consistent regardless of theme.
 */
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { visibleWidth } from "@mariozechner/pi-tui";

// ── ANSI helpers ─────────────────────────────────────────────────────────────
const RESET_FG = "\x1b[39m";
const BOLD_ON = "\x1b[1m";
const BOLD_OFF = "\x1b[22m";

function fg24(r: number, g: number, b: number, text: string): string {
  return `\x1b[38;2;${r};${g};${b}m${text}`;
}

function lerp(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

// ── Gradient: Violet → Indigo → Sky → Cyan ──────────────────────────────────
const GRADIENT_STOPS: [number, number, number][] = [
  [167, 139, 250], // #A78BFA  violet
  [129, 140, 248], // #818CF8  indigo
  [56, 189, 248], // #38BDF8  sky
  [34, 211, 238], // #22D3EE  cyan
];

/** Sample the multi-stop gradient at position t ∈ [0,1]. */
function sampleGradient(t: number): [number, number, number] {
  const segments = GRADIENT_STOPS.length - 1;
  const raw = t * segments;
  const idx = Math.min(Math.floor(raw), segments - 1);
  const local = raw - idx;
  const a = GRADIENT_STOPS[idx]!;
  const b = GRADIENT_STOPS[idx + 1]!;
  return [lerp(a[0], b[0], local), lerp(a[1], b[1], local), lerp(a[2], b[2], local)];
}

// ── Brand text renderer ──────────────────────────────────────────────────────

function renderBrandText(): string {
  // "✦ Bytes ✦" — sparkles + text, all bold, symmetric gradient
  const label = "✦ Bytes ✦";
  const chars = [...label];
  const colorable = chars.filter((c) => c !== " ");
  const steps = Math.max(colorable.length - 1, 1);

  let result = BOLD_ON;
  let ci = 0;

  for (const char of chars) {
    if (char === " ") {
      result += " ";
      continue;
    }
    const [r, g, b] = sampleGradient(ci / steps);
    result += fg24(r, g, b, char);
    ci++;
  }

  result += BOLD_OFF + RESET_FG;
  return result;
}

// Pre-render once — the gradient is static.
const BRAND_LINE = renderBrandText();
const BRAND_VISIBLE_WIDTH = visibleWidth(BRAND_LINE);

// ── Public API ───────────────────────────────────────────────────────────────

export function setupBranding(ctx: ExtensionContext): void {
  // Only set up widget when running in interactive mode (not -p / JSON).
  if (!ctx.hasUI) return;

  ctx.ui.setWidget("bytes-brand", () => ({
    render: (width: number) => {
      // Right-align with 1-char right margin
      const pad = Math.max(0, width - BRAND_VISIBLE_WIDTH - 1);
      return [" ".repeat(pad) + BRAND_LINE];
    },
    invalidate: () => {},
  }));
}
