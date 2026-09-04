import assert from "node:assert/strict";
import { test } from "node:test";
import { linkPreviewCapability } from "./linkPreviewCapability.ts";

/**
 * Capability detection decides whether the composer offers previews at all.
 * Getting it wrong in the permissive direction means every link 404s against
 * an upstream relay; in the strict direction the feature silently disappears.
 */

const BASE = "https://relay.example";

test("a relay advertising the extension and path is usable", () => {
  const capability = linkPreviewCapability(
    {
      link_preview: { unfurl: "/link-preview/unfurl" },
      supported_extensions: ["nip-er", "buzz-link-preview"],
    },
    BASE,
  );
  assert.deepEqual(capability, {
    mediaOrigin: "https://relay.example",
    unfurlPath: "/link-preview/unfurl",
  });
});

test("a relay without the descriptor is not usable", () => {
  assert.equal(linkPreviewCapability({}, BASE), null);
  assert.equal(linkPreviewCapability(null, BASE), null);
  assert.equal(linkPreviewCapability({ link_preview: {} }, BASE), null);
});

test("a descriptor that is not a relay-relative path is refused", () => {
  // An absolute URL here would let a relay point the client's authenticated
  // POST at somebody else's host.
  assert.equal(
    linkPreviewCapability(
      { link_preview: { unfurl: "https://evil.example/unfurl" } },
      BASE,
    ),
    null,
  );
  assert.equal(
    linkPreviewCapability({ link_preview: { unfurl: 42 } }, BASE),
    null,
  );
});

test("a relay listing extensions but not this one is refused", () => {
  assert.equal(
    linkPreviewCapability(
      {
        link_preview: { unfurl: "/link-preview/unfurl" },
        supported_extensions: ["nip-er", "buzz-gif"],
      },
      BASE,
    ),
    null,
  );
});

test("the media origin comes from the relay base, not the document", () => {
  // Snapshot assets are validated against this origin, so it must be derived
  // from where the client is actually talking, never from relay-supplied JSON.
  const capability = linkPreviewCapability(
    { link_preview: { unfurl: "/link-preview/unfurl" } },
    "https://relay.example:8443/some/path",
  );
  assert.equal(capability.mediaOrigin, "https://relay.example:8443");
});
