import {
  Bold,
  Code,
  HatGlasses,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Quote,
  SquareCode,
  Strikethrough,
} from "lucide-react";
import { cn } from "@/shared/lib/cn";
import type { ActiveMarks } from "../lib/composerActiveMarks.ts";
import {
  applyCode,
  applyCodeBlock,
  applyLinePrefix,
  applyLink,
  applyOrderedList,
  applySpoiler,
  applyWrap,
  type FormatResult,
} from "../lib/composerFormat.ts";

export type FormatFn = (
  text: string,
  start: number,
  end: number,
) => FormatResult;

/**
 * The ten formatting controls, in the desktop toolbar's order and with its
 * icons (`desktop/src/features/messages/ui/FormattingToolbar.tsx`). The web
 * client previously shipped seven — code block, ordered list and spoiler were
 * missing.
 *
 * `mark` names the {@link ActiveMarks} field this button reflects through
 * `aria-pressed`, so the pressed state and the transform stay declared
 * together and cannot drift apart.
 */
export const FORMAT_ITEMS: ReadonlyArray<{
  id: string;
  label: string;
  title: string;
  mark: keyof ActiveMarks;
  apply: FormatFn;
  Icon: typeof Bold;
}> = [
  {
    id: "bold",
    label: "Bold",
    title: "Bold (⌘B)",
    mark: "bold",
    apply: (text, start, end) => applyWrap(text, start, end, "**"),
    Icon: Bold,
  },
  {
    id: "italic",
    label: "Italic",
    title: "Italic (⌘I)",
    mark: "italic",
    apply: (text, start, end) => applyWrap(text, start, end, "_"),
    Icon: Italic,
  },
  {
    id: "strike",
    label: "Strikethrough",
    title: "Strikethrough",
    mark: "strike",
    apply: (text, start, end) => applyWrap(text, start, end, "~~"),
    Icon: Strikethrough,
  },
  {
    id: "code",
    label: "Inline code",
    title: "Inline code",
    mark: "code",
    apply: applyCode,
    Icon: Code,
  },
  {
    id: "code-block",
    label: "Code block",
    title: "Code block",
    mark: "codeBlock",
    apply: applyCodeBlock,
    Icon: SquareCode,
  },
  {
    id: "link",
    label: "Link",
    title: "Link",
    mark: "link",
    apply: applyLink,
    Icon: LinkIcon,
  },
  {
    id: "bullet-list",
    label: "Bulleted list",
    title: "Bulleted list",
    mark: "bulletList",
    apply: (text, start, end) => applyLinePrefix(text, start, end, "- "),
    Icon: List,
  },
  {
    id: "ordered-list",
    label: "Ordered list",
    title: "Ordered list",
    mark: "orderedList",
    apply: applyOrderedList,
    Icon: ListOrdered,
  },
  {
    id: "quote",
    label: "Quote",
    title: "Quote",
    mark: "quote",
    apply: (text, start, end) => applyLinePrefix(text, start, end, "> "),
    Icon: Quote,
  },
  {
    id: "spoiler",
    label: "Spoiler",
    title: "Spoiler — hides text until a reader taps it",
    mark: "spoiler",
    apply: applySpoiler,
    Icon: HatGlasses,
  },
];

/**
 * Formatting bar above the composer.
 *
 * `onMouseDown` is where the selection is captured, not `onClick`: pressing a
 * toolbar button moves focus out of the textarea, and some browsers collapse
 * the selection on the way. The composer re-reads and restores the range, so
 * this only has to fire before focus leaves.
 */
export function ComposerFormatToolbar({
  marks,
  disabled,
  onApply,
  onCaptureSelection,
}: {
  marks: ActiveMarks;
  disabled?: boolean;
  onApply: (format: FormatFn) => void;
  onCaptureSelection?: () => void;
}) {
  return (
    <div
      className="mb-1.5 flex flex-wrap items-center gap-0.5"
      role="toolbar"
      aria-label="Format message"
    >
      {FORMAT_ITEMS.map((item) => {
        const active = marks[item.mark];
        return (
          <button
            key={item.id}
            type="button"
            data-testid={`format-${item.id}`}
            aria-label={item.label}
            aria-pressed={active}
            title={item.title}
            className={cn(
              "rounded-md p-1.5 transition-colors disabled:opacity-40",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
            disabled={disabled}
            onMouseDown={onCaptureSelection}
            onClick={() => onApply(item.apply)}
          >
            <item.Icon aria-hidden className="h-4 w-4" />
          </button>
        );
      })}
    </div>
  );
}
