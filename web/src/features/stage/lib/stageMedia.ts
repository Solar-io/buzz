/**
 * Stage's one door to relay media: the signed, app-wide-cached GET that
 * timeline rows use (`fetchSignedMedia`), plus a best-effort decode so a
 * release swaps to an already-decoded bitmap. A separate module so tests can
 * stub Stage's media without stubbing the whole Blossom client.
 */
export { fetchSignedMedia as fetchStageMedia } from "@/shared/api/blossom";

/** Decode an object URL off-screen; resolves either way. */
export function decodeStageImage(objectUrl: string): Promise<void> {
  if (typeof Image === "undefined") return Promise.resolve();
  const image = new Image();
  image.src = objectUrl;
  return typeof image.decode === "function"
    ? image.decode().catch(() => {})
    : Promise.resolve();
}
