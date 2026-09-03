import { Plus } from "lucide-react";
import { cn } from "@/shared/lib/cn";

/** Props for {@link SectionHeader}. */
export interface SectionHeaderProps {
  label: string;
  /** Shows the + button when provided (Channels, Direct messages). */
  onAdd?: () => void;
  addLabel?: string;
  className?: string;
  /**
   * "dm" renders the dm-list-spec.md §2 treatment: sentence case, ~13px,
   * #8E96B0, ink aligned to the avatar left edge (14px) instead of the
   * uppercase channel-section style.
   */
  variant?: "default" | "dm";
}

/**
 * Sidebar section label with the desktop's header-row plus button — the
 * create dialogs open inline just below the header.
 */
export function SectionHeader({
  label,
  onAdd,
  addLabel,
  className,
  variant = "dm",
}: SectionHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-8 items-center justify-between pl-2 pr-1",
        variant === "dm" && "pl-[6px]",
        className,
      )}
    >
      <p
        className={cn(
          "text-xs font-medium uppercase tracking-wide text-sidebar-foreground/70",
          variant === "dm" &&
            "text-[13px] font-medium normal-case tracking-normal text-[#8E96B0]",
        )}
      >
        {label}
      </p>
      {onAdd && (
        <button
          type="button"
          aria-label={addLabel ?? label}
          title={addLabel ?? label}
          className="rounded p-1 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          onClick={onAdd}
        >
          <Plus className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}
