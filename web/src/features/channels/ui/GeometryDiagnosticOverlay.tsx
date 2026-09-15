import { useState } from "react";

/**
 * Device geometry self-diagnostic readout (D-025 criterion 1): shown ONLY
 * when the diagnostic decides the on-screen conversation geometry is wrong
 * (composer-less content or a collapsed timeline). One tap / one screenshot
 * is the whole deliverable — Dwight's condition 2: the phone never meets a
 * laptop. Monospace, bottom-pinned, copyable, dismissable.
 */
export function GeometryDiagnosticOverlay({ lines }: { lines: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = lines.join("\n");
  return (
    <div className="fixed inset-x-0 bottom-0 z-50 max-h-[46vh] overflow-auto border-t-2 border-border bg-card p-3 shadow-2xl">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="text-xs font-semibold">
          Buzz geometry diagnostic — screenshot or copy this whole block
        </p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-1 text-xs"
            onClick={() => {
              navigator.clipboard?.writeText(text).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-tight text-foreground">
        {text}
      </pre>
    </div>
  );
}
