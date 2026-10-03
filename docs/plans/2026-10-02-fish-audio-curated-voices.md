# Fish Audio engine + curated ElevenLabs/Fish voice lists + alphabetical pickers

Status: plan, ready for implementation.
Date: 2026-10-02. Author: architect (Opus 5.5).

Sam's request, verbatim (2026-10-02 20:43 CDT):
"Can you add fish.audio as a audio source too? In the configuration for it I want to be able to add/remove voices. The same thing for ellevenlabs too. Also, the voices should be sorted aphabetically."

---

## 1. Summary

The plan has three deliverables:

1. A fourth bridge engine, `fish`.
2. A curated voice library for `eleven` and `fish`, which Sam edits from Settings.
3. One shared comparator that sorts every voice list.

**Where the library lives.** It is a JSON file owned by `buzz-tts-bridge`. The bridge already holds both API keys, can validate an id against the provider before storing it, and is one store shared by web, iOS and every browser.

**Effect on the pickers.** `GET /voices/eleven` and `GET /voices/fish` return only the curated list, sorted. The engine-first picker gains a third tab, "Fish Audio", and is otherwise unchanged.

**Removal is soft.** Removing a voice takes it out of the pickers. It does not revoke synthesis. Selections stored in the relay (30182/30183) or in browser storage (huddle overrides) keep speaking. They show as "not in library" rows rather than vanishing.

**What `fish` touches.** The new engine string reaches every place that enumerates engines or parses voice keys:

- bridge
- relay ingest grammar (30182/30183)
- CLI
- web (selection parser, precedence, huddle, pickers)
- iOS native (selection grammar, override)
- voicecheck (opt-in probe)

**Design goals:** nothing anyone has selected disappears, one store, no new event kind, provider keys never leave the host, and every grammar checked against one shared vector file so the four parsers cannot drift.

---

## 2. Context and requirements

### 2.1 Verified current state (2026-10-02)

| Fact | Evidence |
|---|---|
| Bridge engines are `chatterbox`, `pocket`, `eleven`. `/healthz` reports `engines:["chatterbox","pocket","eleven"]`. | `shared-infra/buzz-tts-bridge/src/bridge.ts:533,631`, live `curl 127.0.0.1:6365/healthz` |
| `/voices/eleven` returns the whole account library: 46 voices, unsorted, cached 10 min. | `bridge.ts:446-459`, live count 46 |
| All 38 distinct eleven ids in the bridge log (`req=eleven voice=…`) are in that 46. | `comm` of `server.log` ids vs the live library |
| The relay holds no eleven or fish 30182/30183 rows. Live rows: 30182 = chatterbox 1, local-synth 1, pocket 2; 30183 = chatterbox 5. | read-only `psql` on `buzz-dev-postgres-1` |
| The plist runs `…/infra/buzz-tts-bridge/src/index.ts`. `~/software_development/infra` resolves to `projects/shared-infra`, so the canonical shared-infra checkout is what runs. | `com.dev.buzz-tts-bridge.plist`, `readlink -f` |
| The bridge has no `package.json`, so it has no dependencies today. | `ls` |
| The web pickers are `VoicePickerDialog.tsx` (Settings: self and assign) and `HuddleSettingsPopover.tsx` (per-channel override). Both build their rows from `voicePickerOptions.ts engineVoiceOptions()` and render `VoiceEngineTabs`. | source |
| iOS (`ios-web`) is Capacitor and **bundles** `web/dist` (`server.url` intentionally absent). Every picker change reaches iOS only through an iOS rebuild and install. Native Swift parses voice keys (`NativeVoicePolicy.selectionBody`, `NativeAgentVoice.setVoiceOverride`) and does not list voices. | `ios-web/capacitor.config.ts`, Swift sources |
| Desktop (Tauri) huddles use a local Pocket registry (`AgentVoiceMenu.tsx`, `voicesForBackend(registry,"pocket")`). They do not parse eleven today. | source |
| The Flutter `mobile/` app has no voice-selection code. | grep for 30182, 30183, eleven, chatterbox |

### 2.2 Fish Audio API (verified from the docs and live calls, 2026-10-02)

Sources:

- https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- https://docs.fish.audio/api-reference/endpoint/model/list-models
- https://docs.fish.audio/api-reference/endpoint/model/get-model
- https://docs.fish.audio/developer-guide/models-pricing/models-overview
- https://docs.fish.audio/developer-guide/models-pricing/pricing-and-rate-limits
- SDK `fishaudio/fish-audio-python@4481509` (`core/client_wrapper.py`, `types/shared.py`)

**TTS request**

| Item | Value |
|---|---|
| Endpoint | `POST https://api.fish.audio/v1/tts` |
| Auth header | `Authorization: Bearer $FISH_AUDIO_API_KEY` |
| Content type | `content-type: application/json` |
| Model header | `model: s2.1-pro`. Docs: "recommend `s2.1-pro` for production"; the SDK default is the same. Allowed values: `s1`, `s2-pro`, `s2.1-pro`, `s2.1-pro-free`, `drama-3-preview`. |
| Body | `{"text":…,"reference_id":<voice id>,"format":"pcm","sample_rate":24000,"latency":"balanced","normalize":true}` |

**Model header gotcha.** The bridge must send a model from an allowlist. Live, an unknown `model` header did not behave like `s2.1-pro`: "Hi." came back as 6.2 s of audio instead of 0.6 s.

**PCM output (live)**

- `format:"pcm"` at 24000 is **headerless s16le mono**, `content-type: audio/pcm`.
- "Hello there." produced 46,670 bytes; ffprobe reads 0.972 s at s16le/24000/1ch.
- The response streams chunked. Warm first byte arrives in about 0.25 s; the first (cold) call took 1.48 s.
- Valid pcm rates: 8000, 16000, 24000, 32000, 44100. So no resampling or conversion is needed, and the bridge contract (PCM16LE 24 kHz) holds by passthrough, exactly like `eleven` with `pcm_24000`.
- Chunk boundaries can be odd. The web client already carries the odd byte (`bridgeSpeech.ts alignPcmChunk`), and iOS plays through the same stream path. The bridge passes bytes through and does not realign.

**Errors.** Bodies are JSON (`content-type: application/json`), never `audio/*`. So the bridge checks status and content type before it streams.

| Status | Meaning | Source |
|---|---|---|
| 401 | bad key | live |
| **400** `Reference not found` | unknown `reference_id` | live |
| 402 | out of credit | docs |
| 429 | concurrency limit; no `Retry-After` | docs |
| 503 | overload | docs |

**Voice endpoints**

| Endpoint | Behaviour |
|---|---|
| `GET https://api.fish.audio/model/{id}` | Returns `{_id,title,languages,state,visibility,type,author,…}`. Unknown id is **404**. Live: `FISH_AUDIO_VOICE_ID` is "India", en, public, `state:"trained"`, and belongs to someone else. |
| `GET https://api.fish.audio/model?self=true&page_size=100` | The account's own voices. Live total is 1: "Jame". |
| `GET https://api.fish.audio/model?title=<q>&page_size=50&sort_by=task_count` | Public library search. `page_size` max is 100. |

**Id shape.** Observed ids are 32 lowercase hex, and `FISH_AUDIO_VOICE_ID` matches `^[0-9a-f]{32}$`. The docs do not state a grammar.

**Pricing.** `s2.1-pro` costs $15 per million UTF-8 bytes; one preview line is about $0.0004. The account's concurrency limit is 15 (header `ratelimit-limit-concurrency`).

**Transport.** WebSocket `wss://api.fish.audio/v1/tts/live` is **not** used. It only helps with incrementally arriving text; the bridge always has the whole utterance.

### 2.3 Functional requirements

- **F1.** `fish` is a selectable engine everywhere `eleven` is: Settings "Your voice", Settings "Agent voices" (owner assign, 30183), the agent profile card, and the in-huddle per-channel override. It speaks in web huddles, in iOS native huddles, and through Preview.
- **F2.** Settings has a **Voice library** card with ElevenLabs and Fish Audio tabs, showing the curated list.
- **F3.** In that card, **add** a voice by id or pasted URL, or from a browse/search list of provider voices.
- **F4.** In that card, **remove** a voice.
- **F5.** Every voice list shown to a user is sorted case-insensitively by display label: both picker surfaces, all three engine tabs, the library card, and the browse list.

### 2.4 Non-functional requirements

| Requirement | Target |
|---|---|
| First audio for `fish` | ≤ 1.5 s p50 at the bridge, warm (the provider measures about 0.25 s) |
| Library edits | Survive bridge restart and redeploy; the store lives outside the git checkout |
| Who can mutate the library | Only allowlisted admin pubkeys (Sam), never "anyone on the tailnet" |
| Keys | Never sent to clients; request text never logged (existing bridge rule) |
| Old clients | A pre-change web or iOS client that sees a `fish` 30182/30183 row degrades to "no selection" (derived voice) and never crashes |

### 2.5 Assumptions

- **A1.** Sam is the only library admin. The admin set is a config list, so adding a second admin needs no code change.
- **A2.** Fish voices may be anyone's public model, as `FISH_AUDIO_VOICE_ID` is. The plan allows public ids and labels them with the author. A public voice can be deleted by its owner; synthesis then fails with 400 and the selection falls back (§4.6).

---

## 3. Acceptance criteria

**AC-1: Fish engine (bridge)**

1. `POST /tts {engine:"fish", voice:<FISH_AUDIO_VOICE_ID>, text:"Hello there."}` returns 200 with:
   - `content-type: audio/L16; rate=24000; channels=1`
   - `x-tts-engine: fish`
   - `x-tts-voice: fish:<id>`
   - an even byte count whose s16le/24k/mono duration is 0.5–2.0 s
2. An unknown id returns 502 `{error}` containing `fish 400`, and no audio bytes.
3. A non-audio upstream body (JSON error) never streams to the client.
4. A voice not matching `^[A-Za-z0-9]{16,64}$` returns 400 before any upstream call (the fake upstream sees 0 calls).
5. `/healthz` `engines` equals `["chatterbox","pocket","eleven","fish"]` and reports `fishKey: loaded|missing`.

**AC-2: Curated library (bridge)**

1. `GET /voices/eleven` and `GET /voices/fish` return only stored rows, sorted case-insensitively by label.
2. `POST /voices/fish {id}` with a valid NIP-98 header from an admin:
   - unknown id (upstream 404): returns 404 and stores nothing.
   - known id: returns 201 with the row, and the file on disk contains it.
3. A mutation without NIP-98 returns 401. A non-admin signer returns 403. A stale `created_at` (over 60 s) returns 401. A wrong payload hash returns 401. A replayed nonce returns 401.
4. A removed voice is absent from `GET /voices/<engine>`, but `POST /tts` with that id still returns 200 (soft removal).
5. With no store file, first start seeds:
   - `eleven` from the full account library (46 today)
   - `fish` from `FISH_AUDIO_VOICE_ID` plus `GET /model?self=true`
   A corrupt store returns 503 on the library endpoints and is never overwritten.

**AC-3: Sorting (web + desktop)**

1. For each engine tab in `VoicePickerDialog`, `HuddleSettingsPopover` and the Voice library card, rendered row labels equal `[...labels].sort(collator.compare)` with `Intl.Collator("en",{sensitivity:"base",numeric:true})`. This is tested with a fixture containing mixed case, a leading digit, and an accented letter.
2. The desktop `AgentVoiceMenu` Pocket list is sorted the same way.

**AC-4: Fish end to end (relay, web, iOS)**

1. The relay accepts a 30182/30183 with `{engine:"fish",key:"fish:<32hex>"}` and rejects `fish:`, `fish:short`, a key over 64 id chars, and `fish:has space`. Rust, web and Swift tests all read the same vector file.
2. In Agent Brave, Settings, assign the Fish tab's "Jame" voice to an agent:
   - the relay returns `OK true`
   - the network panel shows `POST /tts` → `x-tts-engine: fish` on Preview
3. In a web huddle, that agent's reply plays through the bridge with `x-tts-engine: fish`.
4. On iOS, after install, the picker shows the Fish Audio tab sorted, and a native huddle speaks the fish-assigned agent.

**AC-5: Add/remove UI**

1. In Agent Brave, add a Fish voice by pasting `https://fish.audio/m/<id>`. It appears in the library and in the picker's Fish tab at its sorted position within 1 s of the confirm.
2. Removing it shows a confirm dialog that lists every agent whose 30183/30182 uses that key. After confirm:
   - the voice is gone from the picker
   - an agent still assigned to it is listed in "Agent voices" with its label and a "not in library" badge
   - the agent still speaks it
3. A non-admin session sees the library read-only, with no Add/Remove controls.

---

## 4. Architecture

### 4.1 Components and responsibilities

```
 Browser / iOS webview (bundled web)                 crichton
 ┌──────────────────────────────────────┐   https  ┌────────────────────────────────────────────┐
 │ VoicePickerDialog / HuddleSettings-  │  :6366   │ buzz-tts-bridge (Bun, launchd)             │
 │ Popover  ── GET /voices/{engine} ────┼─────────►│  /tts            engine router              │
 │ VoiceLibraryCard ── GET …/available ─┼─────────►│   ├ chatterbox → :6302 (fallback pocket)    │
 │   ── POST/DELETE /voices/{engine} ───┼─NIP-98──►│   ├ pocket     → :6300                      │
 │ bridgeSpeech / voicePreview ─ POST /tts ───────►│   ├ eleven     → api.elevenlabs.io          │
 │                                      │          │   └ fish (NEW) → api.fish.audio/v1/tts      │
 │ publish 30182 / 30183 ───────────────┼──wss────►│  voice library store (NEW)                  │
 └──────────────────────────────────────┘  :6351   │   ~/.local/state/buzz-tts-bridge/           │
                                                   │      voice-library.json                     │
 iOS NativeAgentVoice ── POST /tts (native) ──────►│                                            │
                                                   └────────────────────────────────────────────┘
 buzz-relay (docker, :6350/:6351): validates 30182/30183 payload grammar (adds `fish`)
```

| Component | Change |
|---|---|
| **buzz-tts-bridge** | Adds a `fish` adapter, a voice-library store and its endpoints, NIP-98 admin auth, sorted voice responses, and `/healthz` additions. |
| **buzz-relay ingest** | Adds a `fish` arm to `validate_agent_voice_payload`. The relay checks grammar only, never membership in the library. The library is presentation; synthesis is not gated by it. |
| **buzz-cli** | `voices select/assign` accept `fish:<id>`. |
| **web** | `fish` in every engine union and parser; a shared sort; a third engine tab; a new `VoiceLibraryCard` plus `voiceLibraryApi`. |
| **iOS native** | Fish grammar in `selectionBody` and `setVoiceOverride`. The rebuilt bundle carries the web changes. |
| **voicecheck** | An opt-in `fish` probe proving fish is served **as** fish, with intelligible output. |

### 4.2 Bridge: fish adapter

New config fields:

| Field | Source | Default |
|---|---|---|
| `fishKey` | `FISH_AUDIO_API_KEY` | none |
| `fishBase` | `FISH_AUDIO_BASE_URL` | `https://api.fish.audio` |
| `fishModel` | `FISH_AUDIO_MODEL` | `s2.1-pro`, validated against the allowlist `{s1, s2-pro, s2.1-pro, s2.1-pro-free}`. An invalid value logs and uses the default. `drama-3-preview` is deliberately excluded (preview). |

Adapter sketch (mirrors `adapterEleven`, plus abort and content-type checks):

```ts
async function adapterFish(voice: string, text: string, signal: AbortSignal) {
  const upstream = new AbortController();
  signal.addEventListener("abort", () => upstream.abort(), { once: true });
  const res = await fetch(`${cfg.fishBase}/v1/tts`, {
    method: "POST",
    headers: { authorization: `Bearer ${cfg.fishKey}`, "content-type": "application/json", model: cfg.fishModel },
    body: JSON.stringify({ text, reference_id: voice, format: "pcm", sample_rate: 24000, latency: "balanced", normalize: true }),
    signal: upstream.signal,
  });
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok || !res.body || !ct.startsWith("audio/")) {
    throw new Error(`fish ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  return passthrough(res.body.getReader(), new Uint8Array(0), upstream); // cancel → abort upstream
}
```

How `handleTts` routes `fish`:

- `engine==="fish"`: strip an optional `fish:` prefix, test `FISH_ID = /^[A-Za-z0-9]{16,64}$/` (400 on failure), require `fishKey` (502 `no FISH_AUDIO_API_KEY configured`), then run the adapter.
- Response headers are `served="fish"` and `usedVoice="fish:<id>"`.
- No Pocket fallback. That matches eleven, where a failed cloud voice is a 502 and the client's existing failure path applies. Section 4.6 explains why.

The `model` field in the `/tts` payload is ignored for fish. The bridge uses `cfg.fishModel`, so a client cannot pick a pricier or preview model. (Eleven keeps today's behaviour.)

**Loudness.** Live peak amplitude was 2279/32767, which is quiet. The live check (§7.4) compares fish loudness with eleven by ear and with RMS. If fish is more than 6 dB quieter, the follow-up adds `prosody:{normalize_loudness:true}` in the body (a documented field). That is a single-line change behind its own test. No client-side gain is added.

### 4.3 Bridge: voice library store

**Location.** `TTS_VOICE_LIBRARY_PATH`, default `$HOME/.local/state/buzz-tts-bridge/voice-library.json`.

- It is outside the git checkout on purpose. Deploys sync from the repo, and a store inside it would be reverted or committed.
- The directory is created `0700` on first write.

**Schema (v1)**

```json
{
  "version": 1,
  "engines": {
    "eleven": [{ "id": "CwhRBWXzGAHq8TQ4Fs17", "label": "Roger - Laid-Back, Casual, Resonant (american)",
                 "detail": null, "addedAt": "2026-10-03T01:00:00Z", "addedBy": "seed" }],
    "fish":   [{ "id": "<32hex>", "label": "India", "detail": "en · by <author nickname>",
                 "addedAt": "…", "addedBy": "<admin hex pubkey>" }]
  }
}
```

The label is captured once, at add time, from the provider: the eleven label format from `bridge.ts:455`, and the fish `title`. Labels are not refreshed. A rename endpoint is out of scope; see §8 open items.

**Writes.**

- All mutations go through one in-process promise-chain mutex, so concurrent requests serialize.
- Each write is `tmp file + fsync + rename` (atomic).
- Before each write, the previous file is copied to `voice-library.json.bak-<UTC stamp>`, keeping the newest 10.
- An audit line is logged: `[library] add engine=fish id=… by=<pubkey8> label="…"`.

**Startup**

| State | Behaviour |
|---|---|
| File present and valid | Load it. |
| File missing | **Seed**, write, and log `[library] seeded eleven=N fish=M`. Seed sources: eleven gets the full `GET /v1/voices` account library (46 today), so nothing visible today disappears. fish gets `FISH_AUDIO_VOICE_ID` (if set) plus `GET /model?self=true` (all pages). If a provider is unreachable or keyless, that engine seeds `[]` and records `seedPending:["eleven"]`. The next successful upstream call for that engine completes the seed exactly once, so a cold-boot network blip never permanently empties the list. |
| File present but unparseable or wrong version | Library endpoints return 503 `voice library unreadable`. `/tts` keeps working. The file is **never** overwritten automatically. Recovery is by hand from the newest `.bak-*`. |

**Seed completeness for relay rows.** A one-shot step at deploy (§6, Phase 1) runs a read-only SQL query for `eleven:`/`fish:` keys in live 30182/30183 rows and adds any id missing from the seed, using `POST` as the admin (or the `--include` flag of the seed script). Today that query returns zero rows (verified), so the step is a guard, not a migration.

Browser-local huddle overrides cannot be enumerated server-side. They keep working because removal is soft, and the full-library seed covers them anyway.

### 4.4 Bridge: HTTP contract

All responses carry the existing CORS headers.

| Method / path | Auth | Request | Response |
|---|---|---|---|
| `GET /voices/eleven` | none | | `200 {voices:[{id,label,detail?}], curated:true}`, sorted. `503` keyless. `503` store unreadable. |
| `GET /voices/fish` | none | | same shape |
| `GET /voices/{engine}/available?q=` | none | eleven: `q` filters the account library by label, client side. fish: no `q` lists own models (`self=true`); with `q`, searches the public library (`title=q`, `page_size=50`, `sort_by=task_count`). | `200 {voices:[{id,label,detail,inLibrary}]}`, sorted. 10-minute upstream cache per (engine, q). |
| `POST /voices/{engine}` | NIP-98 admin | `{"id":"<id or URL>"}`. The bridge normalizes a pasted `https://fish.audio/m/<id>` (fish) or bare id. | `201 {voice, voices}` when added. `200 {voice, voices, existed:true}` when already present (idempotent). `400` bad grammar. `404` provider does not know the id. `502` provider error. |
| `DELETE /voices/{engine}/{id}` | NIP-98 admin | | `200 {removed:true\|false, voices}` (idempotent) |

Provider validation on add:

- **eleven:** `GET /v1/voices/{id}`. A 404/400 rejects with: "not in this ElevenLabs account — add it in ElevenLabs' Voice Library first."
- **fish:** `GET /model/{id}`. The model must have `type==="tts"` and `state==="trained"`, else 422 `voice not usable`.

Other contract points:

- **Sorting at the bridge** uses the same comparator semantics: `localeCompare(b.label, "en", {sensitivity:"base", numeric:true})`, tie-broken by `id`. The web sorts again, because the client is the contract (§4.7).
- **`/healthz` gains** `engines` (adds `"fish"`), `fishKey: loaded|missing`, `library: {eleven:N, fish:M, readable:bool}`, and `libraryAdmins: [hex…]`. The web uses `libraryAdmins` to decide whether to render Add/Remove. That is a UX hint only; the bridge enforces.
- **CORS:** `access-control-allow-methods: GET, POST, DELETE, OPTIONS` and `access-control-allow-headers: content-type, authorization, x-auth-tag`. `ALLOWED_ORIGINS` is unchanged. iOS uses CapacitorHttp (native requests, no CORS), which already reaches `/tts` and `/voices/eleven` today.

### 4.5 Bridge: admin authentication (NIP-98)

**Why not just tailnet + CORS?** CORS stops other web origins, but not any process on the tailnet. That includes about 70 agent seats with shell, any of which might "helpfully" curl the endpoint. NIP-98 is Buzz's existing HTTP auth: `web/src/shared/lib/nip98.ts makeNip98AuthHeader` already signs a kind-27235 event with the session key and adds a nonce plus a payload hash. It also gives the audit log a real author.

**Verification steps**, all must pass, in `src/nip98.ts`:

1. `Authorization: Nostr <base64(event json)>` parses. `kind === 27235`.
2. `|now - created_at| ≤ 60 s`.
3. The `method` tag equals the request method.
4. The `u` tag: compare **origin-independent**. Its pathname and search must equal the request's. Its host must be in `{TTS_BRIDGE_PUBLIC_HOST (default crichton.tailb3d4b8.ts.net:6366), 127.0.0.1:6365, localhost:6365}`. This is required because `tailscale serve` hands the bridge `http://127.0.0.1:6365/...` while the browser signed `https://crichton…:6366/...`.
5. For POST, the `payload` tag equals sha256(hex) of the exact body bytes.
6. The event id recomputes correctly and the Schnorr signature verifies (`@noble/curves/secp256k1` `schnorr.verify`).
7. `pubkey ∈ TTS_BRIDGE_ADMIN_PUBKEYS`, comma-separated lowercase hex, else **403**.
8. Nonce tag not seen in the last 120 s (in-memory LRU, max 1000), else 401.

**Dependency.** This adds the bridge's first dependency: `package.json` with `@noble/curves` pinned exact, plus a committed `bun.lock`. `deploy-dev.sh` runs `bun install --frozen-lockfile` before the restart, and a failed install aborts **before** the plist is touched.

**Secrets and config**, all in the existing Infisical project `534404e2-…`, env `dev`:

| Name | Status | Use |
|---|---|---|
| `FISH_AUDIO_API_KEY` | exists | TTS and model lookups |
| `FISH_AUDIO_VOICE_ID` | exists | seed only |
| `ELEVENLABS_API_KEY` | exists | |
| `TTS_BRIDGE_ADMIN_PUBKEYS` | **new**, not secret but kept out of the repo | Sam's hex pubkey. Take it from the author of the live 30183 rows, or from `buzz` CLI identity on Sam's session, and confirm it with Sam. |
| `FISH_AUDIO_MODEL` | optional | |
| `TTS_VOICE_LIBRARY_PATH` | optional | |

There is no plist change beyond passing env through. `infisical run` already injects the whole project env.

### 4.6 Removal semantics and the fallback when a fish/eleven voice fails

**Removal is "un-offer", not "revoke".** Synthesis is never gated on library membership. Rejected alternative: a hard allowlist at `/tts`. It would silently mute or redirect agents whose 30182 (agent-owned, which Sam cannot rewrite) names the voice. That makes "remove" destructive and contradicts "nothing anyone has selected disappears".

**UI handling of an in-use voice:**

- `VoicePickerDialog` and `HuddleSettingsPopover`: if the current selection's key is not in the curated list, render it as a pinned first row, labelled `<stored label> · not in library`. It is selectable and previewable; below it, the sorted list. The current value never "disappears" from the control.
- `AgentVoicesCard` and `VoiceSettingsCard` already show the label stored in the 30182/30183 row. They add a "not in library" badge for eleven/fish keys missing from the curated list.
- **Remove confirm** (`VoiceLibraryCard`) computes in-use from data the web already subscribes to:
  - `useAgentVoiceAssignments` (30183)
  - `useAgentVoiceSelections` (30182)
  - a scan of `localStorage` keys `buzz.huddle.prefs.*` on this device
  It lists the agents and rooms affected and states that they keep their voice until reassigned.

**When a cloud voice cannot synthesize** (the provider deleted a public fish voice, credit runs out, 401/402/429), the bridge returns 502 exactly as eleven does today. The client's existing failure handling applies. The bridge does **not** add a Pocket/Chatterbox fallback for cloud engines in this change; it is a behaviour change beyond the ask and is listed in §9.

### 4.7 Sorting: one comparator, applied at the list builders

`web/src/features/voice/ui/voicePickerOptions.ts`:

```ts
const collator = new Intl.Collator("en", { sensitivity: "base", numeric: true });
export function sortVoiceOptions<T extends { label: string; key: string }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => collator.compare(a.label, b.label) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
```

- `engineVoiceOptions()` returns `sortVoiceOptions(...)` for **every** engine, including Chatterbox. Both picker surfaces call `engineVoiceOptions`, so one call site covers Settings (self and assign), the profile card and the huddle popover.
- `filterVoiceOptions` preserves order.
- The pinned "not in library" row (§4.6) is prepended **after** sorting.
- `VoiceLibraryCard` (curated and browse lists) uses the same `sortVoiceOptions`.
- Desktop: `desktop/src/features/huddle/components/AgentVoiceMenu.tsx` sorts `voicesForBackend(registry,"pocket")` with the same collator semantics, via a local copy (the desktop and web packages do not share code). `selectedVoice`'s default (`voices[0]`) must keep using the **unsorted** registry's first entry, so a missing setting does not change which voice an agent gets.
- iOS lists no voices natively, so it gets sorting from the bundled web.
- The CLI `voices list` prints raw 30181 catalog JSON. It is not a picker and is not touched.

### 4.8 Web surface changes, complete inventory

**Changes for `fish` (engine union, parser, routing)**

| File | Change |
|---|---|
| `voice/lib/agentVoiceSelection.ts` | Variant `{engine:"fish"; key:string}`; `isValidFishKey` = `^fish:[A-Za-z0-9]{16,64}$`; parse branch; doc block |
| `voice/lib/voicePrecedence.ts` | Engine union adds `"fish"` |
| `voice/lib/agentVoiceSummary.ts:82-84` | Pass `fish` through like `eleven` |
| `voice/lib/chatterboxRoster.ts:116` | Engine display name `fish` → "Fish Audio" (or delegate to `engineLabel`) |
| `voice/lib/voiceCatalog.ts` | Pocket-catalog only (30181). Confirm there is no engine enumeration; no change expected (listed for completeness) |
| `voice/lib/agentVoiceApi.ts:46-53` | Generic over engine; add a `fish` publish test |
| `voice/lib/agentSpeechPlayer.ts:315,342` | Generic `${engine}:${voice}`; add a fish case to `useAgentSpeechPlayer.test.mjs` |
| `voice/hooks.ts` | Replace `useElevenVoices` with `useBridgeVoices(engine: "eleven"\|"fish")`, a plain fetch of `/voices/{engine}`. Its only importers are `VoicePickerDialog.tsx` and `HuddleSettingsPopover.tsx`; migrate both and delete it. Add `useVoiceLibraryAdmin()` reading `/healthz.libraryAdmins` against the session pubkey. Re-fetch after library mutations (simple version counter in a module-level store). |
| `voice/ui/voicePickerOptions.ts` | `VoiceEngine` adds `"fish"`; `VOICE_ENGINES = ["chatterbox","eleven","fish"]`; `engineLabel` → "Fish Audio"; `initialEngine` handles fish; `fishVoiceOptions`; `VoiceOptionSources.fishVoices`; `sameOption` accepts fish; **sort** (§4.7); pinned current row helper `withCurrentPinned(options, current, label)` |
| `voice/ui/VoiceEngineTabs.tsx` | Three tabs. Fix the stale "Pocket \| ElevenLabs" comment |
| `voice/ui/VoicePickerDialog.tsx` | Fish hook and `ready` per engine; description copy names Fish Audio; pinned current row |
| `voice/ui/VoiceSettingsCard.tsx:24` | `fish` summary text and "not in library" badge |
| `voice/ui/AgentVoicesCard.tsx` | "not in library" badge for eleven/fish |
| `voice/ui/voicePreview.ts` | Generic. Add a fish preview test |
| `huddle/lib/bridgeSpeech.ts` | `BridgeSpeakRequest.engine` adds `"fish"`; `selectionToBridgeRequest` fish branch |
| `huddle/lib/huddlePrefs.ts` | `HuddleVoiceEngine` adds `"fish"`; `parseVoice` accepts it |
| `huddle/lib/huddleAgentSpeech.ts:453-570` | Disposition `"fish-bridge"`, union and branch |
| `huddle/useHuddleAgentSpeech.ts:74` | Disposition docs |
| `huddle/ui/HuddleSettingsPopover.tsx` | Fish hook; `ready` per engine; pinned current override row |
| `agents/lib/agentConfigCard.ts`, `profile/ui/AgentConfigSection.tsx` | Verify engine labels go through `engineLabel`/summary; add fish if any literal engine switch exists |

**New files**

| File | Purpose |
|---|---|
| `voice/lib/voiceLibraryApi.ts` | `listLibrary(engine)`, `listAvailable(engine,q)`, `addVoice(engine, idOrUrl)` and `removeVoice(engine, id)`. Mutations use `nip98Headers(url, method, {body})`, with the URL built from `speechServiceUrl("tts")`. Maps 401/403/404/422/502 to user-facing messages. |
| `voice/lib/voiceLibraryModel.ts` | Pure: `parseVoiceInput(engine, raw)` (id or URL → id or error) and `inUseBy(key, assignments, selections, localOverrides)`. |
| `voice/ui/VoiceLibraryCard.tsx` | `data-testid="settings-voice-library"`. ElevenLabs \| Fish Audio tabs; curated sorted list with Preview + Remove; "Add voice" input; "Browse" (eleven: account voices; fish: my voices plus search box) with Add on rows where `inLibrary` is false. Read-only when not admin. |
| `auth/ui/SettingsPage.tsx:290` | Mount `<VoiceLibraryCard />` after `<AgentVoicesCard />` |

### 4.9 Non-web surfaces

| Surface | File | Change | Needed for E2E? |
|---|---|---|---|
| Relay ingest | `crates/buzz-relay/src/handlers/ingest.rs` ~1646-1790 | `AGENT_VOICE_FISH_KEY_MAX = 72`; `valid_fish_voice_key` (`fish:` + 16-64 ASCII alnum); `"fish"` match arm; update both error strings and the doc comment; tests ~5548-5850 | **Yes.** Without it no fish selection or assignment can be saved |
| CLI | `crates/buzz-cli/src/commands/voices.rs:239-248`, `lib.rs:389-411` | Add `"fish"` to the prefix list and the help/usage strings; test `selection_body("fish:<32hex>")` | Yes (agent self-selection path) |
| iOS native | `NativeVoicePolicy.swift:120` | `if engine == "fish", key matches ^fish:[A-Za-z0-9]{16,64}$` | **Yes.** Native huddles drop an unparsed row to the derived voice |
| iOS native | `NativeAgentVoice.swift:106` | Add `"fish"` to the override engine list | Yes (per-channel override in native huddle) |
| iOS tests | `ios-web/native/Tests/BuzzNativeTests/NativeBehaviorTests.swift` | Fish vectors from the shared file | Yes |
| E2E client | `crates/buzz-test-client/tests/e2e_agent_voice.rs` | Add one fish 30182 accept case | Recommended |
| voicecheck | `shared-infra/buzz-voicecheck/voicecheck/engines/fish_engine.py` (new), `engines/__init__.py`, `bin/voicecheck` | Metered engine `fish` (char cap 2000), rendering via bridge `/tts` engine fish; `voicecheck probe --engine fish` asserts `x-tts-engine: fish` and WER ≤ clean class. **Not** in the default `gate --surface bridge` (metered, same policy as eleven). `chatterbox_engine.py:91`'s `"chatterbox" in engines` stays valid. | No (verification tooling) |
| Desktop | `AgentVoiceMenu.tsx` | Sort only (§4.7). Desktop never parsed eleven and does not parse fish; unchanged | Sort only |
| Flutter mobile | none | No voice-selection code | n/a |

**Shared grammar vectors.** New file `test-fixtures/voice/voice-key-grammar.json`:

```json
{ "fish": { "accept": ["fish:0123456789abcdef0123456789abcdef", "fish:ABCDEFGHIJKLMNOP"],
            "reject": ["fish:", "fish:short", "fish:has space", "fish:<65 chars>", "eleven:0123456789abcdef0123456789abcdef"] },
  "eleven": { "accept": [...existing...], "reject": [...existing...] } }
```

Consumers:

- relay: `include_str!` from `ingest.rs` tests
- web: `agentVoiceSelection.test.mjs`, which already reads `test-fixtures/voice` in `bridgeSpeech.test.mjs`
- Swift: `NativeBehaviorTests`, which already reads `derived-agent-voices.json`

A grammar change in one parser and not the others fails a named test.

---

## 5. Cross-cutting concerns

**Security**

- Provider keys stay in the bridge.
- Mutations require NIP-98 from an allowlisted pubkey.
- Upstream URLs are built from validated ids only. Fish ids go in the JSON body; eleven ids are `encodeURIComponent`'d in the path, as today.
- `available?q=` is length-capped at 64 chars and URL-encoded.
- The library file is `0600`.
- Request text is never logged (unchanged).

**Cost**

- Every Preview and every huddle line on fish is metered: $15 per million bytes, so a 100-char line costs $0.0015. There is no new spend cap.
- `/healthz` reporting `fishKey` makes a keyless state visible.
- 429 (concurrency 15) is surfaced as 502 `fish 429`. The client does not retry.

**Observability**

- The existing `[tts] req=fish voice=… served=fish ttfa_ms … bytes …` line, with ttfa for fish measured like chatterbox.
- `[library]` audit lines.
- `/healthz.library`.

**Resilience**

- An upstream fish failure before bytes is a 502. After bytes, the stream ends (the existing passthrough rule).
- Client disconnect aborts the upstream (the adapter wires `signal`).
- A corrupt store never blocks `/tts`.

**Rollback**

- Bridge: `git revert` + `deploy-dev.sh`. The store file is ignored by old code, and old code serves the full eleven library.
- Relay: the recorded previous image tag. Fish rows published in the meantime are rejected by nothing; old readers treat them as no selection.
- Web: `web-dist.bak-<tag>`.
- iOS: reinstall the previous build.

---

## 6. Implementation plan and phasing

Each phase gets its own worktree and branch. The ElevenLabs/Fish *contract* above is fixed, so phases 1-4 can be coded in parallel against fakes. Deploy order is strictly **bridge → relay → web → iOS**:

- Old web against a new bridge works: same `/voices/eleven` shape, now curated.
- New web against an old relay would surface the relay's refusal message for a fish publish, so the relay goes first.

| Phase | Repo / worktree / branch | Scope | Depends on | Parallel? |
|---|---|---|---|---|
| **P1 Bridge** | shared-infra: `git -C ~/software_development/projects/shared-infra worktree add ~/software_development/.evie-worktrees/shared-infra-fish-audio -b claude/fish-audio-bridge` | §4.2-4.5; `package.json` + `bun.lock`; `src/nip98.ts`, `src/library.ts`; `index.ts` header doc; `deploy-dev.sh` `bun install --frozen-lockfile` step; tests §7.1 | none | yes |
| **P2 Relay + CLI + vectors** | buzz: `git -C ~/software_development/projects/buzz worktree add ~/software_development/.evie-worktrees/buzz-fish-relay -b claude/fish-relay-cli` | §4.9 relay, CLI, e2e client, `test-fixtures/voice/voice-key-grammar.json` | none | yes |
| **P3 Web** | buzz: `…/.evie-worktrees/buzz-fish-web -b claude/fish-web` | §4.7-4.8. Takes the vector file from P2 by cherry-picking P2's fixture commit, or creates the identical file; first merge wins and the second resolves trivially | contract only | yes |
| **P4 iOS native** | buzz: `…/.evie-worktrees/buzz-fish-ios -b claude/fish-ios-native` | Swift grammar, override, and tests | vector file | yes. Build and install wait for P3's merge |
| **P5 voicecheck** | shared-infra: `…/.evie-worktrees/shared-infra-fish-voicecheck -b claude/fish-voicecheck` | Fish engine plus the opt-in probe | P1 deployed (for its live run) | yes |
| **P6 Desktop sort** | buzz: `…/.evie-worktrees/buzz-desktop-voice-sort -b claude/desktop-voice-sort` | `AgentVoiceMenu` sort + test | none | yes. **Shipping needs Sam's go** (desktop restart) |

### 6.1 Deploy procedures (real ones, from repo and guides)

**Bridge** (shared-infra, after merge to `main` in the canonical checkout, because the plist runs the canonical path):

1. `voicecheck gate --surface bridge`, as the baseline.
2. Add `TTS_BRIDGE_ADMIN_PUBKEYS` to Infisical dev.
3. `./deploy-dev.sh` in `shared-infra/buzz-tts-bridge`.
4. `curl /healthz`: expect `engines` to include `fish`, `fishKey:loaded`, and `library.eleven:46`.
5. Seed-guard SQL: `docker exec buzz-dev-postgres-1 psql -U buzz buzz -At -c "select distinct content::json->>'key' from events where kind in (30182,30183) and deleted_at is null and content::json->>'engine' in ('eleven','fish')"`. Then add any id that is missing.
6. Gate again.

**Relay** (`GUIDES/RELAY_RECREATE_RULES.md` + Chatterbox design §4.6; `deploy-buzz-dev.sh` **recreates without rebuilding**):

1. From canonical buzz `main` at the merge SHA: `docker build -t buzz-relay:<sha9> .`
2. Record the current `BUZZ_IMAGE` (today `buzz-relay:c026962d5`, in `deploy/compose/.env`).
3. `voicecheck gate --surface relay`, as the baseline.
4. `pg_dump` snapshot per the guide.
5. Repin `BUZZ_IMAGE` in `deploy/compose/.env`, keeping a `.env.bak-<tag>`.
6. Compose recreate, project `buzz-dev`, using the five files the live container was created with: `compose.yml`, `compose.web.yml`, `dev-kit/compose.loopback.yml`, `dev-kit/compose.pairing.yml`, `compose.push-gateway.yml`.
7. Post gate.
8. `docker inspect` shows the new tag.
9. A fish 30182 probe returns `OK true`.

**Web** (`GUIDES/WEB_BUNDLE_DEPLOY_RULES.md`, served from `~/.evie/buzz/web-dist`, mounted by the relay at `:6351`):

1. `voicecheck gate --surface web`.
2. Merge to `main`.
3. Build from canonical `main`: `pnpm --filter buzz-web build`. Then `git merge-base --is-ancestor <sha> HEAD`.
4. `~/.buzz/tools/changelog add …` **before** rsync.
5. `cp -R ~/.evie/buzz/web-dist ~/.evie/buzz/web-dist.bak-fish`, then `rsync -a web/dist/ ~/.evie/buzz/web-dist/`.
6. `curl -skL https://crichton.tailb3d4b8.ts.net:6351/repos | grep -o 'index-[^"]*\.js'` equals the built hash.

**iOS** (`~/.buzz/GUIDES/BUZZ_BUILD_AND_INSTALL.md`):

1. Detached worktree at the merged `main` SHA.
2. Copy `Signing.local.xcconfig`.
3. `pnpm install --frozen-lockfile && pnpm --filter buzz-ios-web build`.
4. `xcodebuild … -configuration Release -derivedDataPath ios-web/build-device build`.
5. `xcrun devicectl device install app` to the iPad `5E0752B0-…` and the iPhone `062C8F9E-…`. Devices must be unlocked. Install over the top, never uninstall. Cancel any scheduled retry installs first.

**Desktop** (P6): per the same guide, only with Sam's explicit go for the restart.

---

## 7. Test plan

Contracts and the named runner:

| Package | Command |
|---|---|
| bridge | `bun test` in `buzz-tts-bridge` |
| web | `pnpm test` in `web/` (not bare `bun test`) |
| relay | `cargo test -p buzz-relay agent_voice` |
| CLI | `cargo test -p buzz-cli voices` |
| iOS | `pnpm --filter buzz-ios-web test:native` |
| desktop | `pnpm test` in `desktop/` |

Every run reports the **test count**, not just pass/fail.

### 7.1 Bridge (`src/bridge.test.ts` + new `src/library.test.ts`, `src/nip98.test.ts`)

Fake upstreams: a fish fake on `Bun.serve` that records calls, plus the existing eleven fake extended with `GET /v1/voices/{id}`.

| Named test | Mutation that must turn it red |
|---|---|
| `fish proxies pcm 24k with bearer, model header, reference_id` (asserts the body `{format:"pcm",sample_rate:24000,reference_id}`, `authorization: Bearer test-fish`, `model: s2.1-pro`, and the response headers) | `sample_rate: 44100`, or drop the `model` header |
| `fish upstream JSON error is a 502, zero audio bytes` (fake returns 200 with `application/json`) | Remove the content-type check |
| `fish unknown reference_id → 502 "fish 400"` | Swallow upstream status |
| `fish voice grammar 400 before upstream` (`fish.calls.length === 0`) | Remove the `FISH_ID` test |
| `fish client disconnect aborts upstream` (fake observes abort) | Drop the signal wiring |
| `fish model env outside allowlist falls back to s2.1-pro` | Pass env through unchecked |
| `/healthz reports four engines, fishKey, library, admins` (replaces the existing `toEqual([...3])`) | Omit `fish` |
| `GET /voices/eleven is the curated store, sorted (fixture: "bella","Adam","Émile","10 Ten","zed")`, expected order hardcoded | Remove the sort, or return the upstream library |
| `add fish validates upstream: unknown id 404, store unchanged` | Skip the lookup |
| `add fish accepts a pasted fish.audio/m/<id> URL` | Drop URL normalization |
| `add is idempotent (200 existed:true, one row)` | Push without the dedupe |
| `remove then GET omits; /tts with removed id still 200` | Gate `/tts` on membership |
| `library survives restart (new createBridge on same path)` | Keep the store in memory only |
| `concurrent adds both persist` (20 parallel POSTs → 20 rows) | Remove the mutex |
| `missing store seeds eleven from upstream (46-style fixture) and fish from env id + self models` | Seed `[]` |
| `upstream down at seed → seedPending; next success completes once` | Write an empty seed as final |
| `corrupt store → 503 on library routes, /tts 200, file bytes unchanged` | Treat corrupt as empty |
| `nip98: no header 401 / non-admin 403 / stale 401 / bad payload hash 401 / bad sig 401 / replayed nonce 401 / u host mismatch 401 / tailnet-signed u accepted on loopback request 200` (8 named cases) | Each check removed in turn; its named case goes red |

The test fixture key is generated in-test with `@noble/curves` `schnorr.utils.randomPrivateKey`.

### 7.2 Relay and CLI

| Named test | Mutation that must turn it red |
|---|---|
| `agent_voice_fish_vectors_accept` (reads `voice-key-grammar.json`) | Delete the `"fish"` arm |
| `agent_voice_fish_vectors_reject` | Loosen to `fish:.+` |
| `agent_voice_assignment_fish_uses_30182_grammar` (30183) | Bypass the shared validator for 30183 |
| Error-string test at `ingest.rs:5817` updated to the five-engine list | |
| CLI `selection_body_fish` | Drop `"fish"` from the prefix list |
| `e2e_agent_voice` adds a fish accept case | Runs under `just test` |

### 7.3 Web (`pnpm test`)

| Named test | Mutation that must turn it red |
|---|---|
| `voicePickerOptions: engineVoiceOptions sorts every engine case-insensitively` (one fixture per engine, expected order hardcoded) | Remove the `sortVoiceOptions` call; or remove it for chatterbox only (separate assertion) |
| `voicePickerOptions: VOICE_ENGINES is chatterbox, eleven, fish; engineLabel(fish) = "Fish Audio"` | |
| `voicePickerOptions: withCurrentPinned keeps a removed current voice first, rest sorted` | Prepend before sorting |
| `agentVoiceSelection: fish vectors from voice-key-grammar.json` | Loosen the regex |
| `bridgeSpeech: selectionToBridgeRequest(fish)` → `{engine:"fish", voice:<id>}` | |
| `huddlePrefs: fish override round-trips` | |
| `huddleAgentSpeech: fish selection → disposition fish-bridge` | |
| `voicePrecedence` / `agentVoiceSummary` fish cases | |
| `voiceLibraryApi: add signs NIP-98 over the exact body (payload tag = sha256(body))` | Sign `undefined` body |
| `voiceLibraryApi: 403 maps to the "only the voice-library admin" message` | |
| `voiceLibraryModel: parseVoiceInput fish URL/id/garbage` | |
| `voiceLibraryModel: inUseBy finds 30183, 30182 and local overrides` | Drop the localStorage source |

`VoicePickerDialog.test.mjs` and `AgentVoicesCard.test.mjs` are updated for three tabs and the badge.

### 7.4 Live checks (required; unit tests cannot detect "shipped and dead")

**L1, bridge.** Run under `timeout 30`:

```
POST https://crichton.tailb3d4b8.ts.net:6366/tts {engine:"fish", voice:$FISH_AUDIO_VOICE_ID, text:"Fish audio is live in Buzz."}
```

Expect `x-tts-engine: fish`. ffprobe s16le/24k duration 1-4 s. Then `voicecheck probe --engine fish`, where STT WER is at most the clean class. Record RMS against an eleven render of the same line (the loudness decision, §4.2).

**L2, UI** (Agent Brave; own tab; closed on every exit path):

1. Settings → Voice library → Fish Audio → Browse → "Jame" → Add.
2. It appears sorted, and Preview's network row shows `x-tts-engine: fish`.
3. Agent voices → assign "Jame" to a test agent → relay OK.
4. Huddle popover Fish tab shows it sorted.
5. Remove "Jame". The confirm lists the test agent; after confirm, the picker shows the pinned "not in library" row and the agent card shows the badge.
6. Re-add it.
7. ElevenLabs tab: remove one voice, confirm it leaves the picker, re-add it from Browse.

Screenshot each step. Then clear the test assignment.

- **Identity caveat:** add/remove succeed only if Agent Brave's Buzz session signs as an admin pubkey. If Agent Brave's identity is not Sam's, temporarily include its pubkey in `TTS_BRIDGE_ADMIN_PUBKEYS` for the test window, then remove it and redeploy. Record both changes. The non-admin read-only case (AC-5.3) is checked in the same session before the pubkey is added.

**L3, web huddle.** A huddle with the fish-assigned test agent. Its reply's `/tts` response has `x-tts-engine: fish`, and it is audible (or the voicecheck web rig capture shows bridge playback).

**L4, iOS.** After install: the picker's Fish Audio tab, sorted, and Preview plays. A native huddle with the fish-assigned agent speaks. This needs Sam's devices unlocked; the iOS-specific part is Sam-assisted.

---

## 8. Risks and trade-offs

| Decision | Chosen | Alternatives rejected | Why |
|---|---|---|---|
| Library location | Bridge JSON store | (a) A new replaceable nostr kind authored by Sam. (b) Browser localStorage. (c) A static JSON in the repo. | (a) needs a new kind, relay validation, an "admin author" rule every reader must implement, and gives no provider validation at add time. (b) is per-device, which is exactly what Sam's multi-device use rules out. (c) needs a commit and deploy per edit. The bridge already owns keys and provider calls. |
| Removal | Soft (un-offer) | Hard allowlist at `/tts` | A hard allowlist would silently change voices Sam cannot reassign (agent-owned 30182) and violates "nothing selected disappears". |
| Mutation auth | NIP-98 + admin allowlist | Tailnet + CORS only | CORS does not stop tailnet curl from about 70 agent seats. NIP-98 already exists in web and adds attribution. Cost: the bridge's first dependency (`@noble/curves`) and URL-canonicalization care (tested). |
| Eleven seed | Full current account library (46) | Only voices seen in logs or relay rows | Guarantees nothing currently pickable disappears. Sam prunes from there. |
| Fish failure | 502 like eleven, no fallback | Chatterbox/Pocket fallback | A behaviour change beyond the ask; logged in §9. |
| Key grammar | `fish:[A-Za-z0-9]{16,64}` | Strict `[0-9a-f]{32}` | Observed ids are 32 hex but the docs do not promise it. Loosening later costs a relay image, web and iOS release. The bound still rejects junk, and the bridge validates against the provider on add. |
| Model | Pinned `s2.1-pro` at the bridge | Client-supplied | An unknown model header misbehaved live, and preview models should not be reachable from a client. |

**Risks**

- **Public fish voice deleted by its owner.** Likelihood medium, impact one voice goes silent: synthesis returns 400, surfaced as 502, and the existing client failure path applies. Mitigation: label the author in `detail`; Sam can clone a voice he owns.
- **Fish loudness lower than other engines.** Measured in L1, with a one-line fix behind a test.
- **Two browsers editing the library concurrently.** The server mutex serializes. Clients re-fetch after each mutation and show the server's list.
- **Relay deploy trap** (recreate without rebuild). The runbook explicitly builds and repins first, then checks with `docker inspect`.

---

## 9. Open items (engineering, not blocking)

- A Chatterbox fallback for failed cloud voices (eleven and fish), as a separate decision.
- Library label rename (`PATCH /voices/{engine}/{id}`).
- Per-engine spend visibility (Fish `GET /wallet/self/api-credit` in `/healthz`).

## 10. Questions for Sam (product intent only)

1. **Desktop app.** Sorting its Pocket voice menu needs a desktop rebuild and restart. Ship that now, or fold it into the next desktop release? Fish and ElevenLabs voices do not play in desktop huddles today, and this plan does not add them. Say if you expect them there.
2. **Who may edit the voice library.** The plan makes it you only. Should any other identity (for example a specific agent) be able to add or remove voices?
3. **Fish Audio public voices.** Browse/search includes the public Fish library (your configured "India" voice is someone else's public model). Is that what you want, or only voices you own or clone?

## 11. Verdict

**Ready for implementation.** P1-P5 can start in parallel. P6 ships only after Sam answers question 1. Q2 and Q3 change configuration and UI scope only, not the contracts above.
