import { ArrowRight, Hash, Lock, Search } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";

import { AuthorAvatar } from "@/features/channels/ui/AuthorAvatar";
import type { JumpCandidate } from "@/features/channels/lib/jump.ts";
import { cn } from "@/shared/lib/cn";

/**
 * One row of the ⌘K jump list (Jump artboard): a glyph for what it is, the
 * label with the typed text marked, a status hint on the right (coral when
 * something there needs you) and the ↵ key on the selected row.
 *
 * Like `SearchResultRow`, the row is a button that is never focused — the
 * input keeps the caret and selection travels by `aria-activedescendant`.
 */
export function JumpRow({
  id,
  item,
  needle,
  selected,
  onActivate,
  onHover,
}: {
  id: string;
  item: JumpCandidate & { pubkey?: string; isPrivate?: boolean };
  needle: string;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (selected) {
      ref.current?.scrollIntoView({ block: "nearest" });
    }
  }, [selected]);
  return (
    <button
      ref={ref}
      id={id}
      data-testid={id}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
      onMouseMove={onHover}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm",
        selected ? "bg-chip" : "hover:bg-accent",
      )}
    >
      <Glyph item={item} />
      <span className="min-w-0 truncate whitespace-pre">
        {item.kind === "command" ? "/" : ""}
        <Marked text={item.label} needle={needle} />
      </span>
      {item.hint ? (
        <span
          className={cn(
            "ml-auto min-w-0 max-w-[45%] shrink truncate pl-3 text-xs",
            item.hot ? "font-semibold text-coral-ink" : "text-muted-foreground",
          )}
        >
          {item.hint}
        </span>
      ) : null}
      {selected ? (
        <kbd
          className={cn(
            "shrink-0 rounded-[5px] border border-line-2 bg-card px-[5px] font-mono text-2xs text-ink-2",
            !item.hint && "ml-auto",
          )}
        >
          ↵
        </kbd>
      ) : null}
    </button>
  );
}

/** "Search messages for "q"" — the last row, which switches the panel over. */
export function SearchMessagesRow({
  id,
  needle,
  selected,
  onActivate,
  onHover,
}: {
  id: string;
  needle: string;
  selected: boolean;
  onActivate: () => void;
  onHover: () => void;
}) {
  return (
    <button
      id={id}
      data-testid={id}
      type="button"
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onActivate}
      onMouseMove={onHover}
      className={cn(
        "flex h-10 w-full items-center gap-2.5 rounded-[9px] px-2.5 text-left text-sm",
        selected ? "bg-chip" : "hover:bg-accent",
      )}
    >
      <span className="grid w-5.5 place-items-center text-muted-foreground">
        <Search aria-hidden className="size-3.75" />
      </span>
      <span className="min-w-0 truncate">
        Search messages for “<b className="font-semibold">{needle}</b>”
      </span>
      <span className="ml-auto shrink-0 text-xs text-muted-foreground">
        full text
      </span>
      {selected ? (
        <kbd className="shrink-0 rounded-[5px] border border-line-2 bg-card px-[5px] font-mono text-2xs text-ink-2">
          ↵
        </kbd>
      ) : null}
    </button>
  );
}

function Glyph({
  item,
}: {
  item: JumpCandidate & { pubkey?: string; isPrivate?: boolean };
}): ReactNode {
  if (item.kind === "channel") {
    return (
      <span className="grid w-5.5 shrink-0 place-items-center text-faint">
        {item.isPrivate ? (
          <Lock aria-hidden className="size-3.5" />
        ) : (
          <Hash aria-hidden className="size-3.75" />
        )}
      </span>
    );
  }
  if ((item.kind === "dm" || item.kind === "person") && item.pubkey) {
    return (
      <AuthorAvatar
        pubkey={item.pubkey}
        label={item.label}
        size="sm"
        className="size-5.5"
      />
    );
  }
  if (item.kind === "command") {
    return (
      <span className="grid size-5.5 shrink-0 place-items-center rounded-md bg-chip font-mono text-xs font-semibold text-ink-2">
        /
      </span>
    );
  }
  return (
    <span className="grid size-5.5 shrink-0 place-items-center rounded-md bg-chip text-ink-2">
      <ArrowRight aria-hidden className="size-3.25" />
    </span>
  );
}

/** The label with the first case-insensitive occurrence of `needle` marked. */
function Marked({ text, needle }: { text: string; needle: string }) {
  const at = needle ? text.toLowerCase().indexOf(needle) : -1;
  if (at < 0) {
    return <>{text}</>;
  }
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-honey-soft font-bold text-inherit">
        {text.slice(at, at + needle.length)}
      </mark>
      {text.slice(at + needle.length)}
    </>
  );
}
