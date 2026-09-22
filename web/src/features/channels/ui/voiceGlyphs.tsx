/**
 * The two voice glyphs on the composer's action row (Sam, 2026-09-22 — the
 * single "Call" pill became an Anthropic-style pair: an outline microphone
 * for dictation and a solid circle with a white bar waveform for the call).
 *
 * Inline SVG on purpose: the repo's icon set is lucide, but these two are the
 * reference screenshot's exact shapes (thin-stroke mic, filled 5-bar
 * waveform), and hand-rolled paths keep them dependency-free and versionable
 * beside the only component that renders them.
 */

/** Thin-stroke microphone — the dictation affordance. */
export function MicGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
    >
      <rect height="12" rx="3" width="6" x="9" y="2" />
      <path d="M5 10v1a7 7 0 0 0 14 0v-1" />
      <path d="M12 18.5V22" />
    </svg>
  );
}

/**
 * Five vertical rounded bars of varying height, centered — the voice-call
 * glyph. Heights are a fixed rhythm (short, mid, tall, mid, short), vertically
 * centered on the 24-unit grid so the mark sits optically centered in a
 * circular button at any size.
 */
const WAVEFORM_BARS = [
  { x: 3, height: 7 },
  { x: 7.5, height: 12 },
  { x: 12, height: 17 },
  { x: 16.5, height: 12 },
  { x: 21, height: 7 },
] as const;

export function WaveformGlyph({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
    >
      {WAVEFORM_BARS.map((bar) => (
        <rect
          height={bar.height}
          key={bar.x}
          rx={1}
          width={2}
          x={bar.x}
          y={12 - bar.height / 2}
        />
      ))}
    </svg>
  );
}
