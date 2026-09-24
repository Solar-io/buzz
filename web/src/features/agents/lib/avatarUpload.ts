/**
 * Accept a Blossom upload descriptor as an agent avatar: the server-sniffed
 * mime must be an image (the picker's mime is client-supplied, so the
 * server's word wins — same check as the profile editor) and the URL must be
 * http(s). Pure, React-free for the node runner.
 */
export function acceptAvatarDescriptor(descriptor: {
  url: string;
  mime_type: string;
}): { url: string } | { error: string } {
  if (!descriptor.mime_type.startsWith("image/")) {
    return { error: "Choose a PNG, JPG, GIF, or WebP image." };
  }
  let protocol: string;
  try {
    protocol = new URL(descriptor.url).protocol;
  } catch {
    return { error: "The upload returned an invalid URL." };
  }
  if (protocol !== "https:" && protocol !== "http:") {
    return { error: "The upload returned a non-http URL." };
  }
  return { url: descriptor.url };
}
