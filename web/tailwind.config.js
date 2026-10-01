/** @type {import('tailwindcss').Config} */
export default {
  theme: {
    extend: {
      // Sub-`text-xs` ramp for meta text (timestamps, count badges, tracking
      // labels) and tiny glyphs. These follow the virtual typography rem
      // (`--buzz-type-rem` in shared/styles/globals.css), which is
      // rem-relative: Cmd +/- zooms it with the rest of the layout, and the
      // Font size preference nudges it alone. Do NOT reintroduce arbitrary
      // `text-[…rem]` / `text-[…px]` literals; the px-text guard
      // (`scripts/check-px-text.mjs`) rejects them. Stock scale picks up from
      // xs. Ported from the desktop client's tailwind.config.js.
      fontSize: {
        "2xs": "calc(var(--buzz-type-rem) * 0.6875)", // 11px at 16px type rem
        "3xs": "calc(var(--buzz-type-rem) * 0.5)", // 8px at 16px type rem
        badge: "calc(var(--buzz-type-rem) * 0.625)", // 10px at 16px type rem
        // 13px at 16px type rem — sidebar secondary rows (left-nav redesign
        // "N more" row), between text-xs (12) and text-sm (14).
        "sidebar-meta": "calc(var(--buzz-type-rem) * 0.8125)",
        // Shared channel, DM, thread, and composer type. Variables keep app-wide
        // font size and keyboard zoom consistent without branching components.
        message: [
          "var(--conversation-message-font-size)",
          { lineHeight: "var(--conversation-message-line-height)" },
        ],
        "message-timestamp": [
          "var(--conversation-timestamp-font-size)",
          { lineHeight: "var(--conversation-timestamp-line-height)" },
        ],
        // 40px at the 16px type rem — onboarding page titles.
        title: [
          "calc(var(--buzz-type-rem) * 2.5)",
          { lineHeight: "1.15", letterSpacing: "-0.02em" },
        ],
        // 36px at the 16px type rem — backup-step private key.
        "nsec-key": [
          "calc(var(--buzz-type-rem) * 2.25)",
          { lineHeight: "1.3" },
        ],
      },
      lineHeight: {
        // Keep fixed Tailwind line-height utilities in the typography scale so
        // Cmd +/- cannot enlarge glyphs inside an unchanged line box. Single-
        // line surfaces keep their existing truncate/overflow behavior.
        3: "calc(var(--buzz-type-rem) * 0.75)",
        4: "var(--buzz-type-rem)",
        5: "calc(var(--buzz-type-rem) * 1.25)",
        6: "calc(var(--buzz-type-rem) * 1.5)",
        7: "calc(var(--buzz-type-rem) * 1.75)",
        8: "calc(var(--buzz-type-rem) * 2)",
        "message-author": "var(--conversation-author-line-height)",
      },
      spacing: {
        4.5: "1.125rem",
        "conversation-body": "var(--conversation-body-gap)",
        "conversation-list": "var(--conversation-list-item-gap)",
        "conversation-paragraph": "var(--conversation-paragraph-gap)",
        "conversation-row": "var(--conversation-row-padding-block)",
      },
      boxShadow: {
        "content-edge": "-1px -1px 0 0 hsl(var(--sidebar-border) / 0.45)",
        // Edge + elevation for a surface anchored to the right of the content
        // area, whose only exposed edge faces left. Tailwind's stock shadows are
        // all y-offset, so they cast almost nothing sideways — `shadow-xl` on a
        // left-facing edge is nearly invisible. Both layers run -x so they wrap
        // the surface's rounded left corners: the hairline draws the boundary
        // (and carries dark mode, where a black shadow reads as nothing), the
        // soft layer carries the lift. A left-only `border` can't do this job —
        // it tapers out at each corner instead of turning it.
        "panel-left":
          "-1px 0 0 0 hsl(var(--border) / 0.8), -16px 0 32px -12px rgb(0 0 0 / 0.18)",
        // Redesign elevation (phase-0.md §2.3): --elev-shadow is a whole color.
        elev: "0 12px 32px -12px var(--elev-shadow)",
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      fontFamily: {
        sans: [
          '"Inter Variable"',
          "Inter",
          '"Avenir Next"',
          '"Segoe UI"',
          "sans-serif",
        ],
        mono: [
          '"JetBrains Mono"',
          "ui-monospace",
          "SFMono-Regular",
          "Menlo",
          "monospace",
        ],
      },
      colors: {
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        sidebar: {
          DEFAULT: "hsl(var(--sidebar-background))",
          foreground: "hsl(var(--sidebar-foreground))",
          primary: "hsl(var(--sidebar-primary))",
          "primary-foreground": "hsl(var(--sidebar-primary-foreground))",
          // Selected-row fill. Declared in globals.css for both themes and
          // overridden at runtime when the user picks an accent.
          active: "hsl(var(--sidebar-active))",
          "active-foreground": "hsl(var(--sidebar-active-foreground))",
          accent: "hsl(var(--sidebar-accent))",
          "accent-foreground": "hsl(var(--sidebar-accent-foreground))",
          border: "hsl(var(--sidebar-border))",
          ring: "hsl(var(--sidebar-ring))",
        },
        status: {
          added: "var(--status-added)",
          deleted: "var(--status-deleted)",
          modified: "var(--status-modified)",
        },
        warning: {
          DEFAULT: "var(--ui-warning)",
          bg: "var(--ui-warning-bg)",
        },
        // Web redesign semantic tokens (phase-0.md §2.3), declared in
        // globals.css `:root` / `.dark` and in palettes.css. `info` (not
        // `blue`) and `idle` (not ring-idle/hex-idle) avoid shadowing
        // Tailwind's own palette names.
        sunk: "hsl(var(--sunk))",
        chip: "hsl(var(--chip))",
        "ink-2": "hsl(var(--ink-2))",
        faint: "hsl(var(--faint))",
        "line-2": "hsl(var(--line-2))",
        rail: "hsl(var(--rail))",
        vit: "hsl(var(--vit))",
        "surface-neutral": "hsl(var(--surface-neutral))",
        work: {
          DEFAULT: "hsl(var(--work))",
          foreground: "hsl(var(--work-foreground))",
        },
        need: {
          DEFAULT: "hsl(var(--need))",
          foreground: "hsl(var(--need-foreground))",
        },
        honey: {
          soft: "hsl(var(--honey-soft))",
          wash: "hsl(var(--honey-wash))",
          line: "hsl(var(--honey-line))",
          ink: "hsl(var(--honey-ink))",
        },
        coral: {
          soft: "hsl(var(--coral-soft))",
          wash: "hsl(var(--coral-wash))",
          line: "hsl(var(--coral-line))",
          ink: "hsl(var(--coral-ink))",
        },
        leaf: {
          DEFAULT: "hsl(var(--leaf))",
          soft: "hsl(var(--leaf-soft))",
          line: "hsl(var(--leaf-line))",
          ink: "hsl(var(--leaf-ink))",
        },
        info: {
          soft: "hsl(var(--info-soft))",
          line: "hsl(var(--info-line))",
          ink: "hsl(var(--info-ink))",
        },
        idle: {
          ring: "hsl(var(--idle-ring))",
          hex: "hsl(var(--idle-hex))",
          "hex-ink": "hsl(var(--idle-hex-ink))",
        },
        human: {
          DEFAULT: "hsl(var(--human))",
          ink: "hsl(var(--human-ink))",
        },
        // Terminal (Phase 7): whole colours in redesign.css, not triples.
        term: {
          DEFAULT: "var(--term)",
          ink: "var(--term-ink)",
          dim: "var(--term-dim)",
          tab: "var(--term-tab)",
          add: "var(--term-add)",
          "add-ink": "var(--term-add-ink)",
          hl: "var(--term-hl)",
          warn: "var(--term-warn)",
        },
        key: "var(--key)",
      },
    },
  },
};
