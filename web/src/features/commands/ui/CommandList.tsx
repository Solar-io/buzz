import { cn } from "@/shared/lib/cn";
import {
  COMMAND_GROUP_LABEL,
  type CommandGroup,
  type CommandSpec,
} from "../lib/commands.ts";

/**
 * The slash-command list above the composer (Commands artboard): a titled
 * popover, commands grouped by what they are for, the highlighted row
 * carrying the ↵ key. It renders what it is given — matching, grouping order
 * and keyboard handling live in the registry and the composer's suggestion
 * hook, so the list cannot disagree with what Enter will run.
 *
 * Rows are buttons that are never focused: the textarea keeps the caret, and
 * `onMouseDown` is prevented so a click does not blur it first.
 */
export function CommandList({
  commands,
  selected,
  context,
  onPick,
}: {
  commands: readonly CommandSpec[];
  /** Index into `commands` of the highlighted row. */
  selected: number;
  /** "in #flight-path" — where the commands will run. */
  context?: string;
  onPick: (command: CommandSpec) => void;
}) {
  if (commands.length === 0) {
    return null;
  }
  const groups: CommandGroup[] = [];
  for (const command of commands) {
    if (!groups.includes(command.group)) {
      groups.push(command.group);
    }
  }
  return (
    <div
      role="listbox"
      aria-label="Commands"
      data-testid="command-list"
      className="absolute bottom-full left-3 z-20 mb-1.5 w-[min(38.75rem,calc(100%-1.5rem))] rounded-[14px] border border-line-2 bg-popover p-1.5 text-popover-foreground shadow-elev md:left-5"
    >
      <div className="flex items-center justify-between px-2.5 py-1.5 text-xs text-muted-foreground">
        <b className="font-semibold text-foreground">Commands</b>
        {context ? (
          <span className="truncate pl-3 font-mono text-2xs">{context}</span>
        ) : null}
      </div>
      {groups.map((group, groupIndex) => (
        <div key={group}>
          <div
            className={cn(
              "px-2.5 pt-2 pb-1 text-2xs font-semibold uppercase tracking-[0.08em] text-muted-foreground",
              groupIndex > 0 && "mt-1 border-t border-border",
            )}
          >
            {COMMAND_GROUP_LABEL[group]}
          </div>
          {commands
            .filter((command) => command.group === group)
            .map((command) => {
              const active = commands.indexOf(command) === selected;
              return (
                <button
                  key={command.id}
                  type="button"
                  role="option"
                  aria-selected={active}
                  data-testid={`command-option-${command.id}`}
                  tabIndex={-1}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => onPick(command)}
                  className={cn(
                    "flex h-8 w-full items-center gap-3 rounded-lg px-2.5 text-left",
                    active ? "bg-chip" : "hover:bg-accent",
                  )}
                >
                  <span className="w-36 shrink-0 truncate font-mono text-xs">
                    <b className="font-semibold">/{command.id}</b>
                    {command.args ? (
                      <span className="font-normal text-muted-foreground">
                        {" "}
                        {command.args}
                      </span>
                    ) : null}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 flex-1 truncate text-sidebar-meta",
                      active ? "text-foreground" : "text-ink-2",
                    )}
                  >
                    {command.describe}
                  </span>
                  {active ? (
                    <kbd className="shrink-0 rounded-[5px] border border-line-2 bg-card px-[5px] font-mono text-2xs text-ink-2">
                      ↵
                    </kbd>
                  ) : null}
                </button>
              );
            })}
        </div>
      ))}
    </div>
  );
}
