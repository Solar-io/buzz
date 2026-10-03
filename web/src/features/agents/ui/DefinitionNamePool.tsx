import { useId } from "react";

/** Ordered names for new agents made from this definition. */
export function DefinitionNamePool({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const hintId = useId();
  return (
    <label className="block space-y-1">
      <span className="block text-sm text-muted-foreground">Name pool</span>
      <textarea
        aria-label="Name pool"
        aria-describedby={hintId}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        rows={3}
        className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm"
      />
      <span id={hintId} className="block text-xs text-muted-foreground">
        One name per line, in order. New agents can use these names.
      </span>
    </label>
  );
}
