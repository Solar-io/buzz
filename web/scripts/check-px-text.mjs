import path from "node:path";
import { fileURLToPath } from "node:url";
import { runPxTextCheck } from "../../scripts/check-px-text-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// Enforces the rem-token text scale app-wide, the same gate the desktop client
// runs. Readable text MUST use a rem-based token (the stock
// `text-base`/`text-sm`/`text-xs` scale, or the `text-2xs` / `text-3xs` /
// `text-badge` meta-text tokens) so Cmd +/- zoom scales it and the size stays
// on one consolidated scale. px literals freeze against zoom; arbitrary rem
// literals re-fragment the scale.
const rules = [
  {
    root: "src",
    extensions: new Set([".ts", ".tsx", ".css"]),
  },
];

// Allowlisted exceptions, keyed `relativePath:matchedLiteral` (the core matches
// on the literal, not the line number, so an entry covers every occurrence of
// that literal in that file — line numbers below are informational).
//
// These are NOT decorative drift: the DM list and channel sidebar were built
// against a measured pixel spec (`dm-list-diff.md`, the "B-target" palette),
// where the type size is quoted alongside a hand-sampled hex — e.g.
// `text-[13px] … text-[#8E96B0]`. Converting them to scale tokens would move
// them off that spec silently, so they are held here to be revisited
// deliberately with the spec in hand, together with the sampled colours.
const overrides = new Set([
  // src/features/sidebar/ui/ChannelSidebar.tsx:158 — ⌘K hint kbd chip.
  "src/features/sidebar/ui/ChannelSidebar.tsx:text-[10px]",
  // src/features/sidebar/ui/ChannelSidebar.tsx:223,247 — section labels,
  // paired with the sampled `text-[#8E96B0]`.
  "src/features/sidebar/ui/ChannelSidebar.tsx:text-[13px]",
  // src/features/sidebar/ui/SectionHeader.tsx:42 — same section-label recipe.
  "src/features/sidebar/ui/SectionHeader.tsx:text-[13px]",
  // src/features/channels/ui/ChannelTimeline.tsx:156,158 — avatar initials
  // sized to their disc; :615,619 — broadcast tag and event-id chip.
  "src/features/channels/ui/ChannelTimeline.tsx:text-[10px]",
  // src/features/channels/ui/SystemMessageRow.tsx:57 — system row eyebrow.
  "src/features/channels/ui/SystemMessageRow.tsx:text-[10px]",
]);

await runPxTextCheck({
  projectRoot,
  rules,
  overrides,
  label: "Web",
  scriptPath: "web/scripts/check-px-text.mjs",
});
