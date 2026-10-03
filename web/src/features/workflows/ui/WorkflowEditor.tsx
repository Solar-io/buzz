import { useId, useState } from "react";
import { Button } from "@/shared/ui/button";
import { Textarea } from "@/shared/ui/textarea";
import { workflowYamlError } from "../lib/workflowPublish.ts";

type Props = {
  initialYaml: string;
  editing: boolean;
  disabled: boolean;
  onSave: (yaml: string) => Promise<void>;
  onCancel: () => void;
  onBusyChange: (busy: boolean) => void;
};

/** A plain-text editor: workflow content and relay verdicts are never HTML. */
export function WorkflowEditor({
  initialYaml,
  editing,
  disabled,
  onSave,
  onCancel,
  onBusyChange,
}: Props) {
  const id = useId();
  const [yaml, setYaml] = useState(initialYaml);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parseError = workflowYamlError(yaml);
  const save = async () => {
    if (disabled || saving || parseError !== null) return;
    setSaving(true);
    onBusyChange(true);
    setError(null);
    try {
      await onSave(yaml);
    } catch (issue) {
      setError(
        issue instanceof Error ? issue.message : "Could not save the workflow.",
      );
    } finally {
      setSaving(false);
      onBusyChange(false);
    }
  };
  return (
    <form
      className="space-y-3"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="text-base font-semibold">
        {editing ? "Edit workflow" : "New workflow"}
      </h2>
      <p className="text-sm text-muted-foreground">
        Define when it runs and the steps it follows.
      </p>
      <label htmlFor={id} className="block text-sm font-medium">
        Workflow YAML
      </label>
      <Textarea
        id={id}
        value={yaml}
        onChange={(event) => {
          setYaml(event.target.value);
          setError(null);
        }}
        disabled={saving}
        aria-invalid={parseError !== null}
        aria-describedby={parseError !== null ? `${id}-validation` : undefined}
        className="min-h-80 resize-y font-mono"
      />
      {parseError !== null && (
        <p
          id={`${id}-validation`}
          role="alert"
          className="break-words text-sm text-coral-ink"
        >
          {parseError}
        </p>
      )}
      {error !== null && (
        <p
          role="alert"
          className="break-words rounded-lg border border-coral-line bg-coral-wash p-3 text-sm text-coral-ink"
        >
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={saving}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <Button
          type="submit"
          className="min-h-11"
          disabled={disabled || saving || parseError !== null}
        >
          {saving ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
