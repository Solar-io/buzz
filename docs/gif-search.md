# Relay-proxied GIF search

Buzz relays can optionally provide GIF search without distributing a provider
credential to desktop clients. An operator configures `BUZZ_KLIPY_API_KEY` in
the relay's secret store. When present, the relay advertises this NIP-11 shape:

```json
{
  "supported_extensions": ["buzz-gif"],
  "gif": { "provider": "klipy", "search": "/gifs/search" }
}
```

The descriptor is provider-agnostic so a relay can advertise another provider
or path later. Clients must require `buzz-gif`, recognize the provider, and use
only a safe relay-relative search path.

`POST /gifs/search` requires NIP-98 authentication and relay membership. It is
limited to 30 requests per minute for each pubkey and community using the shared
Redis admission limiter. The relay sends the provider credential upstream and
returns only allowlisted successful result data. Provider error bodies are
never returned to clients or written to logs.

## Message and rendering boundary

Selecting a GIF sends a normal Buzz message whose NIP-92 metadata references
the KLIPY CDN URL. Buzz does not download, cache, or store the GIF bytes.
Existing image URL rendering handles the message, including pasted GIF URLs on
relays that do not advertise `buzz-gif`. Only the picker is capability-gated.

The relay intentionally has no share endpoint and no render proxy. Those would
add operator egress cost and an open-proxy-shaped security surface for an
IP-privacy benefit that is not currently required. This is a revisitable
non-goal if product or privacy requirements change.
