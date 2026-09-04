# Relay-side link-preview unfurl

Buzz link previews are **sender-authored**. The sender resolves a linked page
once, at send time, and writes the result into the event as `link-preview`
snapshot tags; readers render those tags and never contact the linked site.
That is the privacy property the feature exists for — opening a channel must
not fan out HTTP requests to every domain anyone has ever linked.

A native client does that resolution in-process. A browser cannot: it cannot
read a cross-origin page it did not author, and the snapshot's image and
favicon must be blobs in *this* relay's media store before ingest
(`validate_link_preview_tags`, `crates/buzz-relay/src/handlers/ingest.rs`) will
accept the tag. `POST /link-preview/unfurl` is the missing half.

A relay that can unfurl advertises it in NIP-11:

```json
{
  "supported_extensions": ["buzz-link-preview"],
  "link_preview": { "unfurl": "/link-preview/unfurl" }
}
```

Clients must require both and use only the relay-relative path. A client
talking to a relay without the descriptor must not offer preview authoring.

## Contract

`POST /link-preview/unfurl`, NIP-98 with a payload digest plus the optional
`x-auth-tag` header, then community membership — the same door as `/events`,
`/query` and `/gifs/search`. Request body:

```json
{ "url": "https://example.com/article" }
```

`200` returns the fields a snapshot tag needs, in tag order:

```json
{
  "url": "https://example.com/article",
  "title": "Article title",
  "site": "Example",
  "description": "…",
  "image":   { "url": "https://relay.example/media/<sha256>.jpg", "sha256": "<sha256>" },
  "favicon": { "url": "https://relay.example/media/<sha256>.jpg", "sha256": "<sha256>" }
}
```

`url` is the **requested** URL echoed byte-for-byte, never the post-redirect
one: ingest requires the snapshot's canonical URL to appear verbatim in the
message content, so a normalised URL would be unusable. `image` and `favicon`
are absent when the page had none or the fetch was refused; a caller maps an
absent asset to the tag's empty url/hash pair, which ingest accepts.

`204` means the page yielded no usable preview (no title). This is a normal
outcome, not an error — the message sends with a plain link.

Errors: `400` the URL was refused (not https, credentials, non-default port,
resolves into private space), `401`/`403` auth, `429` per-pubkey quota,
`502` the remote site failed or answered with something unusable, `503` the
relay's unfurl concurrency is exhausted.

## Fetching an attacker-supplied URL

The URL comes from a message someone is about to send, so the endpoint is an
SSRF primitive unless it is fenced. `Egress::send` in
`crates/buzz-relay/src/api/link_preview.rs` is the **single** gate every
outbound request passes through — the first request, every redirect hop, the
image, the favicon:

- `https` only, port 443 only, no embedded credentials.
- DNS is resolved first and **every resolved address** is checked against
  `buzz_core::network::is_private_ip` — loopback, private, link-local
  (including `169.254.169.254`), CGNAT, unique-local IPv6, and the
  IPv4-mapped/translated/NAT64 spellings of all of those. A hostname-only
  check would miss every one of them.
- The addresses that passed are pinned into the HTTP client with
  `resolve_to_addrs`, so the connection goes to an address that was actually
  validated — a second DNS answer cannot be substituted between the check and
  the connect.
- The HTTP client never follows redirects itself. Each hop comes back through
  the gate, and hops are capped at 3.
- Page reads stop at 256 KiB; images at 2 MiB (favicons 512 KiB); one request
  at 5s; the whole unfurl at 20s.
- Images are re-decoded and re-encoded before storage, which rejects
  decompression bombs and animation, proves the bytes are an image, and drops
  third-party EXIF/XMP/ICC so the result satisfies the media store's
  metadata-free contract.

Only `title`, `og:site_name`, `description`, `og:image` and the favicon are
read out of the page; every byte is treated as hostile input.

## Limits an operator can tune

| Variable | Default | What it bounds |
|---|---|---|
| `BUZZ_RATE_LIMIT_LINK_PREVIEWS_PER_MIN` | 20 | Unfurls per pubkey per minute, per community |
| `BUZZ_LINK_PREVIEW_MAX_CONCURRENT` | 4 | Concurrent outbound unfurls for the whole process |

The concurrency cap is what stops the endpoint being used to amplify traffic
at a third party, so lower it rather than raise it if a relay serves a large
community.

## Storage and attribution

Fetched images are stored through the ordinary Blossom upload pipeline with a
kind-24242 auth event signed by the **relay's** key, because the relay is the
party that fetched them; the requesting member never handled the bytes. The
member is bound to the result in the audit log (`MediaUploaded`, with
`source: "link_preview"` and the requested URL), so moderation can still reach
whoever asked for the unfurl.
