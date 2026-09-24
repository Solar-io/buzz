import {
  hasPngMagic,
  kindCap,
  kindLabel,
  snapshotKindForFilename,
} from "./snapshotManifest.ts";

/**
 * Local-file snapshot intake for "Import snapshot…": the checks of
 * `fetchSnapshotBytesWeb` minus the network + sha256 step (a file the owner
 * picked has no declared hash), with the same Rust-derived wording. Team
 * snapshots pass the byte checks here and are then refused by the decoder's
 * `team` marker, exactly like the timeline path. Pure.
 */
export function readSnapshotFile(
  filename: string,
  bytes: Uint8Array,
): { bytes: Uint8Array } | { error: string } {
  const kindResult = snapshotKindForFilename(filename);
  if ("error" in kindResult) {
    return { error: kindResult.error };
  }
  const kind = kindResult.kind;
  const cap = kindCap(kind);
  if (bytes.length > cap) {
    return {
      error: `Snapshot file is too large (${Math.floor(bytes.length / (1024 * 1024))} MiB). ${kindLabel(kind)} snapshots must be under ${cap / (1024 * 1024)} MiB.`,
    };
  }
  const magicIsPng = hasPngMagic(bytes);
  const kindIsPng = kind === "agent-png" || kind === "team-png";
  if (kindIsPng && !magicIsPng) {
    return {
      error: `format mismatch: filename is ${kindLabel(kind)} but bytes are not a PNG`,
    };
  }
  if (!kindIsPng && magicIsPng) {
    return {
      error: `format mismatch: filename is ${kindLabel(kind)} but bytes are a PNG`,
    };
  }
  return { bytes };
}
