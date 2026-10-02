# `buzzweb://` launch-link corpus

The launch-link grammar, executed by **both** implementations:

| Consumer | File | Command |
|---|---|---|
| TypeScript (web client) | `web/src/features/huddle/lib/launchIntent.test.mjs` | `cd web && pnpm test` |
| Swift (`BuzzLaunchPlugin`) | `ios-web/native/Tests/BuzzNativeTests/LaunchPluginTests.swift` | app-hosted `BuzzNativeTests` |

Each case is a RAW link and the request both sides must read from it:
`{"action":"open"}`, `{"action":"call","agent":<string|null>}`, or `null`
(refused). Native stores a call link only when it reads one, and the web
re-parses the stored string, so a link native stores is one the web accepts
with the same agent string. Both suites assert `cases.length === count`, so a
path that resolves to nothing fails loudly instead of running zero cases.

Neither side uses a URL library for this (WHATWG `URL` and Foundation `URL`
disagree on `c%61ll`, `+`, `@call` and an empty `#`). The grammar is:

- `buzzweb://` + host `""`, `open` or `call` (any case) + optional `/` +
  optional `?query`; printable ASCII only, no userinfo, port or fragment.
- `open` takes an empty query. `call` takes an empty query or exactly
  `agent=<value>` — one pair, no `&`, name case-sensitive.
- `<value>`: `+` is a space, then strict UTF-8 percent-decoding (a malformed
  escape refuses the link), then trim Unicode Zs + tab, refuse Cc/Cf, at most
  128 Unicode scalars.
