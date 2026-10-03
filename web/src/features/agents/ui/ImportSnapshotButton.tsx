import { useRef } from "react";
import { Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/shared/ui/button";
import { useSnapshotFileImport } from "./SnapshotPreviewProvider";

/**
 * "Import snapshot…" — picks a local `.agent.json` / `.agent.png` and opens
 * the shared preview dialog on its bytes. The dialog applies the size and
 * magic checks (readSnapshotFile) and the confirm path stays the existing
 * admin `create` (buildSnapshotCreate). Absent outside the provider.
 */
export function useSnapshotFilePicker() {
  const openFile = useSnapshotFileImport();
  const input = useRef<HTMLInputElement>(null);
  return {
    available: Boolean(openFile),
    choose: () => input.current?.click(),
    input: (
      <input
        ref={input}
        type="file"
        accept=".json,.png"
        className="hidden"
        aria-label="Snapshot file"
        data-testid="web-import-snapshot-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (!file || !openFile) {
            return;
          }
          // Never buffer an absurd file just to refuse it: the largest cap
          // (team PNG) is 50 MiB; the dialog applies the exact per-kind cap.
          if (file.size > 50 * 1024 * 1024) {
            toast.error(
              `Snapshot file is too large (${Math.floor(file.size / (1024 * 1024))} MiB).`,
            );
            return;
          }
          file
            .arrayBuffer()
            .then((buffer) => openFile(file.name, new Uint8Array(buffer)))
            .catch(() => toast.error("Could not read that file."));
        }}
      />
    ),
  };
}

export function ImportSnapshotButton() {
  const picker = useSnapshotFilePicker();
  if (!picker.available) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={picker.choose}>
        <Upload aria-hidden className="mr-1 h-4 w-4" />
        Import snapshot…
      </Button>
      {picker.input}
    </>
  );
}
