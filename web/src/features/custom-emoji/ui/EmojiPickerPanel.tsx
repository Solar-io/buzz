import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Search } from "lucide-react";
import { cn } from "@/shared/lib/cn";
import { Input } from "@/shared/ui/input";
import { useGifCapability } from "@/features/gifs/hooks";
import { GifPicker } from "@/features/gifs/ui/GifPicker";
import { gifMarkdown, type KlipyGif } from "@/features/gifs/lib/klipy";
import { reportGifShare } from "@/features/gifs/lib/relay";
import { useCustomEmoji } from "../hooks.ts";
import { searchCustomEmoji, type CustomEmoji } from "../lib/customEmoji.ts";
import {
  loadPickerPrefs,
  pushRecent,
  savePickerPrefs,
  type PickerPrefs,
} from "../lib/pickerPrefs.ts";
import {
  SKIN_TONE_LABELS,
  SKIN_TONE_SWATCHES,
  searchUnicodeEmoji,
  toneGlyph,
  unicodeEmojiCategories,
  type UnicodeEmoji,
} from "../lib/unicodeEmoji.ts";
import { CustomEmojiImage } from "./CustomEmojiImage";

/**
 * The picker body: search, categories, skin tones, the community's custom
 * emoji, and — where the relay offers one — a GIF tab.
 *
 * Only ONE category's grid is mounted at a time. The table holds ~1,900
 * emoji; rendering every one as a button on open costs a visible pause and
 * buys nothing, since eight of the nine sections are scrolled out of view.
 * Search replaces the grid rather than filtering it in place, so the result
 * order can be relevance rather than category order.
 */

/** Category strip glyphs. Deliberately emoji, not icons: they need no lookup
 *  in the icon set and read the same on every platform the app runs on. */
const CATEGORY_GLYPH: Record<string, string> = {
  recent: "🕘",
  custom: "⭐",
  people: "😀",
  nature: "🐻",
  foods: "🍔",
  activity: "⚽",
  places: "✈️",
  objects: "💡",
  symbols: "🔣",
  flags: "🏳️",
};

type Tab = "emoji" | "gifs";

export interface EmojiPickerPanelProps {
  /** Chosen emoji as a string: a unicode glyph, or `:shortcode:`. */
  onSelect: (emoji: string) => void;
  /**
   * Insert a GIF as message markdown. Absent (reaction pickers) hides the GIF
   * tab entirely — a reaction cannot be a GIF.
   */
  onSelectGif?: (markdown: string) => void;
  /** Focus the search field on mount. */
  autoFocus?: boolean;
  /** Called after any selection so the popover can close itself. */
  onDone?: () => void;
}

export function EmojiPickerPanel({
  onSelect,
  onSelectGif,
  autoFocus = true,
  onDone,
}: EmojiPickerPanelProps) {
  const palette = useCustomEmoji();
  const gifCapability = useGifCapability();
  const gifsEnabled = Boolean(onSelectGif) && gifCapability !== null;

  const [tab, setTab] = useState<Tab>("emoji");
  const [query, setQuery] = useState("");
  const [prefs, setPrefs] = useState<PickerPrefs>(loadPickerPrefs);
  const [toneOpen, setToneOpen] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const categories = useMemo(() => unicodeEmojiCategories(), []);
  const sections = useMemo(
    () => [
      ...(prefs.recent.length > 0
        ? [{ id: "recent", label: "Recently used" }]
        : []),
      ...(palette.length > 0 ? [{ id: "custom", label: "Custom" }] : []),
      ...categories.map((category) => ({
        id: category.id,
        label: category.label,
      })),
    ],
    [categories, palette.length, prefs.recent.length],
  );

  // The first section can disappear (recents cleared, palette arrives late),
  // so the active id is validated against the current sections every render
  // rather than trusted.
  const [activeId, setActiveId] = useState<string>("people");
  const active =
    sections.find((section) => section.id === activeId) ?? sections[0];

  useEffect(() => {
    if (autoFocus) {
      searchRef.current?.focus();
    }
  }, [autoFocus]);

  const commit = (value: string) => {
    const next = {
      tone: prefs.tone,
      recent: [...pushRecent(prefs.recent, value)],
    };
    setPrefs(next);
    savePickerPrefs(next);
    onSelect(value);
    onDone?.();
  };

  const chooseTone = (tone: number) => {
    const next = { ...prefs, tone };
    setPrefs(next);
    savePickerPrefs(next);
    setToneOpen(false);
  };

  const results = useMemo(
    () => (query.trim() === "" ? null : searchUnicodeEmoji(query)),
    [query],
  );
  const customResults = useMemo(
    () => (query.trim() === "" ? null : searchCustomEmoji(palette, query)),
    [palette, query],
  );

  if (tab === "gifs" && gifsEnabled && gifCapability && onSelectGif) {
    return (
      <div className="flex h-full flex-col">
        <TabStrip tab={tab} onTab={setTab} />
        <GifPicker
          provider={displayProvider(gifCapability.provider)}
          searchPath={gifCapability.searchPath}
          onSelect={(gif: KlipyGif) => {
            onSelectGif(gifMarkdown(gif));
            void reportGifShare(gifCapability.sharePath, gif.slug);
            onDone?.();
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      {gifsEnabled ? <TabStrip tab={tab} onTab={setTab} /> : null}

      <div className="flex items-center gap-1 p-2">
        <div className="relative flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            ref={searchRef}
            aria-label="Search emoji"
            data-testid="emoji-search-input"
            className="h-9 pl-8"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search emoji"
            type="search"
            value={query}
          />
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label={`Skin tone: ${SKIN_TONE_LABELS[prefs.tone]}`}
            aria-expanded={toneOpen}
            title="Skin tone"
            data-testid="emoji-tone-toggle"
            className="flex h-9 w-9 items-center justify-center rounded-md text-lg hover:bg-accent"
            onClick={() => setToneOpen((open) => !open)}
          >
            {SKIN_TONE_SWATCHES[prefs.tone]}
          </button>
          {toneOpen ? (
            <div className="absolute right-0 top-full z-10 mt-1 flex rounded-md border border-border bg-popover p-1 shadow-lg">
              {SKIN_TONE_SWATCHES.map((swatch, tone) => (
                <button
                  key={swatch}
                  type="button"
                  aria-label={SKIN_TONE_LABELS[tone]}
                  aria-pressed={tone === prefs.tone}
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded text-lg hover:bg-accent",
                    tone === prefs.tone && "bg-accent",
                  )}
                  onClick={() => chooseTone(tone)}
                >
                  {swatch}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {results === null ? (
        <nav
          aria-label="Emoji categories"
          className="flex shrink-0 items-center gap-0.5 border-b border-border/60 px-2 pb-1.5"
        >
          {sections.map((section) => (
            <button
              key={section.id}
              type="button"
              aria-label={section.label}
              aria-current={section.id === active?.id}
              title={section.label}
              data-testid={`emoji-category-${section.id}`}
              className={cn(
                "flex h-7 w-7 items-center justify-center rounded text-base hover:bg-accent",
                section.id === active?.id && "bg-accent",
              )}
              onClick={() => setActiveId(section.id)}
            >
              {CATEGORY_GLYPH[section.id] ?? "•"}
            </button>
          ))}
        </nav>
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {results !== null ? (
          <SearchResults
            custom={customResults ?? []}
            emoji={results}
            onCommit={commit}
            onPreview={setPreview}
            tone={prefs.tone}
          />
        ) : active?.id === "recent" ? (
          <Grid label="Recently used">
            {prefs.recent.map((value) => (
              <RecentCell
                key={value}
                value={value}
                palette={palette}
                onCommit={commit}
                onPreview={setPreview}
              />
            ))}
          </Grid>
        ) : active?.id === "custom" ? (
          <Grid label="Custom">
            {palette.map((entry) => (
              <CustomCell
                key={entry.shortcode}
                entry={entry}
                onCommit={commit}
                onPreview={setPreview}
              />
            ))}
          </Grid>
        ) : (
          <Grid label={active?.label ?? ""}>
            {(
              categories.find((category) => category.id === active?.id)
                ?.emoji ?? []
            ).map((emoji) => (
              <UnicodeCell
                key={emoji.id}
                emoji={emoji}
                onCommit={commit}
                onPreview={setPreview}
                tone={prefs.tone}
              />
            ))}
          </Grid>
        )}
      </div>

      <p className="truncate border-t border-border/60 px-3 py-1.5 text-xs text-muted-foreground">
        {preview ?? "Pick an emoji"}
      </p>
    </div>
  );
}

function TabStrip({ tab, onTab }: { tab: Tab; onTab: (tab: Tab) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Picker"
      className="flex shrink-0 gap-1 border-b border-border/60 p-1.5"
    >
      {(
        [
          ["emoji", "Emoji"],
          ["gifs", "GIFs"],
        ] as const
      ).map(([id, label]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={tab === id}
          data-testid={`picker-tab-${id}`}
          className={cn(
            "flex-1 rounded-md px-2 py-1 text-sm font-medium",
            tab === id
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/60",
          )}
          onClick={() => onTab(id)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Grid({ label, children }: { label: string; children: ReactNode }) {
  // A fieldset rather than a `role="group"` div: it is the semantic element
  // for a labelled set of controls, and `aria-label` names it without a
  // visible legend.
  return (
    <fieldset aria-label={label} className="grid grid-cols-9 gap-0.5">
      {children}
    </fieldset>
  );
}

const CELL_CLASS =
  "flex h-8 w-8 items-center justify-center rounded text-xl leading-none hover:bg-accent focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring";

function UnicodeCell({
  emoji,
  tone,
  onCommit,
  onPreview,
}: {
  emoji: UnicodeEmoji;
  tone: number;
  onCommit: (value: string) => void;
  onPreview: (value: string | null) => void;
}) {
  const glyph = toneGlyph(emoji, tone);
  return (
    <button
      type="button"
      aria-label={emoji.id}
      title={`:${emoji.id}:`}
      data-testid={`emoji-${emoji.id}`}
      className={CELL_CLASS}
      onClick={() => onCommit(glyph)}
      onFocus={() => onPreview(`${glyph}  :${emoji.id}:`)}
      onMouseEnter={() => onPreview(`${glyph}  :${emoji.id}:`)}
    >
      {glyph}
    </button>
  );
}

function CustomCell({
  entry,
  onCommit,
  onPreview,
}: {
  entry: CustomEmoji;
  onCommit: (value: string) => void;
  onPreview: (value: string | null) => void;
}) {
  const token = `:${entry.shortcode}:`;
  return (
    <button
      type="button"
      aria-label={entry.shortcode}
      title={token}
      data-testid={`emoji-custom-${entry.shortcode}`}
      className={CELL_CLASS}
      onClick={() => onCommit(token)}
      onFocus={() => onPreview(token)}
      onMouseEnter={() => onPreview(token)}
    >
      <CustomEmojiImage shortcode={entry.shortcode} url={entry.url} />
    </button>
  );
}

/**
 * A recent pick replays the exact string that was inserted, so a recent custom
 * emoji has to resolve back through the palette to render as an image. One
 * that has since left the palette falls back to its literal `:shortcode:` —
 * the same fallback every other surface uses.
 */
function RecentCell({
  value,
  palette,
  onCommit,
  onPreview,
}: {
  value: string;
  palette: ReadonlyArray<CustomEmoji>;
  onCommit: (value: string) => void;
  onPreview: (value: string | null) => void;
}) {
  const custom = value.startsWith(":")
    ? palette.find((entry) => `:${entry.shortcode}:` === value.toLowerCase())
    : undefined;
  return (
    <button
      type="button"
      aria-label={value}
      title={value}
      className={cn(CELL_CLASS, !custom && "text-base")}
      onClick={() => onCommit(value)}
      onFocus={() => onPreview(value)}
      onMouseEnter={() => onPreview(value)}
    >
      {custom ? (
        <CustomEmojiImage shortcode={custom.shortcode} url={custom.url} />
      ) : (
        <span className="text-xl leading-none">{value}</span>
      )}
    </button>
  );
}

function SearchResults({
  custom,
  emoji,
  tone,
  onCommit,
  onPreview,
}: {
  custom: CustomEmoji[];
  emoji: UnicodeEmoji[];
  tone: number;
  onCommit: (value: string) => void;
  onPreview: (value: string | null) => void;
}) {
  if (custom.length === 0 && emoji.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        No emoji found.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-testid="emoji-search-results">
      {custom.length > 0 ? (
        <section>
          <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
            Custom
          </h3>
          <Grid label="Custom results">
            {custom.map((entry) => (
              <CustomCell
                key={entry.shortcode}
                entry={entry}
                onCommit={onCommit}
                onPreview={onPreview}
              />
            ))}
          </Grid>
        </section>
      ) : null}
      {emoji.length > 0 ? (
        <section>
          {custom.length > 0 ? (
            <h3 className="px-1 pb-1 text-xs font-medium text-muted-foreground">
              Emoji
            </h3>
          ) : null}
          <Grid label="Emoji results">
            {emoji.map((entry) => (
              <UnicodeCell
                key={entry.id}
                emoji={entry}
                onCommit={onCommit}
                onPreview={onPreview}
                tone={tone}
              />
            ))}
          </Grid>
        </section>
      ) : null}
    </div>
  );
}

/** KLIPY is a brand name; the NIP-11 value is a lowercase slug. */
function displayProvider(provider: string): string {
  return provider === "klipy" ? "KLIPY" : provider;
}
