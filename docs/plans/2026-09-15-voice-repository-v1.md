# Voice Repository v1 — Design Document

Buzz platform, step 1 of the approved voice-consolidation plan (`~/.buzz/PLANS/VOICE_CONSOLIDATION_2026-09-15.md`). Architect pass, 2026-09-15. All citations verified against the working tree at `/Users/sgallant/software_development/projects/buzz`.

**Review status (Richard, 2026-09-15):** the four load-bearing claims were independently spot-checked and confirmed — buzz-media audio rejection (`validation.rs` `audio/*` arm), the generic 64-char d-tag bound (`ingest.rs` `single_bounded_d_tag`), kind 30181 unused anywhere, and `VoiceRegistryEntry`/`VoiceProvenance` already carrying `availability` + `license`/`source`/`source_url`. The buzz-media WAV allowance (§4) is the one new security surface and is flagged for Evie/Sam review in §12.

Seed data for future non-bundled rows (the 14 voices on the crichton pocket-tts service, with licenses): `~/.buzz/RESEARCH/VOICE_CATALOG_SEED_2026-09-15.md`.

---

## 1. Summary + Recommendation

**Recommendation: one new NIP-33 parameterized-replaceable kind, `KIND_VOICE_CATALOG = 30181`, one event per voice (d_tag = voice key), community-global, any-member publish (`UsersWrite`), versioned JSON body mirroring the desktop's existing `VoiceRegistryEntry` shape, with bundled presets published as asset-less rows.** Desktop reads by extending the existing `voice_registry()` merge with a relay-fetched, community-keyed cache behind the existing `list_voice_registry` Tauri surface; web reads with a `session.subscribe` hook in a new `web/src/features/voice/` feature; publishing ships as a `buzz voices` CLI group.

One blocking discovery shapes the scope: **the relay's media path rejects audio uploads today** (`crates/buzz-media/src/validation.rs:195-207` — sniffed `audio/*` returns `DisallowedContentType`; "audio is rejected until Buzz has an explicit sanitizer and location-metadata validator"). The "asset path on media" in the plan therefore requires a narrow, designed change: a structural validator for canonical PCM WAV (the exact format `buzz-voice` canonicalizes to) added to the generic file path. Everything else in v1 rides existing machinery: NIP-33 LWW (`crates/buzz-db/src/replaceable.rs:552`), kind-5 coordinate deletion (`crates/buzz-relay/src/handlers/ingest.rs:2702-2716`, `crates/buzz-db/src/event.rs:949-973`), envelope validators (`ingest.rs:1492-1528`), and the generic read gates (`crates/buzz-relay/src/handlers/req.rs:1476-1488`).

Primary trade-off accepted: per-voice events give up single-document atomic reads in exchange for per-voice LWW (concurrent fleet-agent publishes can never clobber each other), per-voice kind-5 deletion, incremental publish, and unbounded growth — the exact properties the single-document model loses. Section 2 has the full analysis.

## 2. Event Design

### 2.1 Granularity: per-voice parameterized-replaceable events

**Chosen: one event per voice, keyed `(author pubkey, kind 30181, d = voice key)`.**

The two candidates, against the actual read/write mechanics in the code:

| Property | Single document (30180 model: one event, embedded rows) | Per-voice NIP-33 (chosen) |
|---|---|---|
| Concurrent publishers | **LWW clobber**: one `(pubkey, kind, d)` slot; two fleet agents publishing near-simultaneously lose rows — the Mary/Azelma class of bug, recreated relay-side | Each voice is its own slot; concurrent publishes compose |
| Per-voice delete | Rewrite the document (no kind-5 subset delete) | Generic kind-5 `a`-tag coordinate delete, already implemented (`ingest.rs:2702-2716` enforces exactly-one target; `side_effects.rs:229-260` verifies authorship; `event.rs:949-973` `soft_delete_by_coordinate` applies it) |
| Growth | 256 KB content cap (`ingest.rs:2239`) bounds the catalog; dozens of imported voices with attribution text fits but erodes headroom | ~500 bytes/event; unbounded |
| Read | One event = atomic snapshot | One REQ returns N events; readers fold by d_tag (every catalog consumer already folds event sets — `web/src/features/user-status/hooks.ts:161-177` is the pattern) |
| Publish | Whole-catalog rewrite per change | Incremental; `publish-bundled` is 12 tiny events in one burst |

The repo's only embedded-members catalog, 30178, was forced into embedding by a *privacy* constraint that does not exist here — unshared 30175 persona rows would be unreadable to a foreign reader of a shared team (`crates/buzz-core/src/kind.rs:317-325`, "Why this is not a `shared` tag"). Voice catalog rows are public by design; there is nothing to embed around. Every other comparable kind is per-entity parameterized-replaceable: 30177 per agent (`desktop/src-tauri/src/managed_agents/agent_events.rs:113-125`), 30175 per slug, 30621 per project slug. Per-voice matches the house pattern; a partial snapshot during a publish burst is harmless because rows are independent and additive.

### 2.2 Kind number: **30181**

- Free: `ALL_KINDS` (`kind.rs:703-835`) has nothing between `KIND_DESKTOP_CATALOG` (30180) and `KIND_EVENT_REMINDER` (30300); the duplicate-detection test `no_duplicate_kind_values` (`kind.rs:992-998`) enforces uniqueness. Grep confirms `30181` appears nowhere in the repo (Rust, TS/TSX, Dart, docs).
- Placement is semantic, not just free: 30177/30178/30179/30180 are the owner-authored *projection* family; the voice catalog is the same shape (signed JSON projection of client-local voice state, world-readable). Desktop and web kind constants mirror it: `desktop/src/shared/constants/kinds.ts:63` ends the family at `KIND_DESKTOP_CATALOG = 30180`; mobile has no 30175/30180 entries (`mobile/lib/shared/relay/nostr_models.dart` — no hits), and per AGENTS.md mobile kinds stay in sync via that file only when mobile consumes a kind, which v1 does not.

### 2.3 Addressing, scope, authorship

- **d_tag = the voice key verbatim** (`pocket:anna`, `pocket:imported:<64-hex>`). REQ-by-key is then `{"kinds":[30181],"#d":["pocket:anna"]}`; the NIP-33 coordinate for deletion is `30181:<author-hex>:pocket:imported:<hash>`. Key-format rules (§3.3) keep d grammar checkable.
- **Community-global**: add the kind to `is_global_only_kind` (`ingest.rs:625-707`), exactly as 30177/30178/30180 are at `ingest.rs:659-663`. Stored with `channel_id = NULL`; a stray `h` tag cannot channel-scope it. This is verified possible — it is precisely the treatment the three neighbors get, and global kinds are REQ-able community-wide by any authenticated member with explicit `kinds` (the p-gate, `req.rs:1290-1324`, only closes filters that can match `P_GATED_KINDS`; the AGENTS.md gotcha "queries must specify kinds" is this same gate). Catalog rows carry **no `h` tag and no channel scoping** — that is the "use anywhere within the web interface" requirement.
- **Authorship: `Scope::UsersWrite`** — the same arm 30175/30176/30177/30178/30180/30179 already use (`ingest.rs:441-444`). Verified: there is **no role or owner check at ingest for any of these kinds** — "owner-authored" in their doc comments describes who publishes, not an enforced gate. The only enforced authorship property is identity: event pubkey must equal the authenticated identity (`ingest.rs:2249-2253`), so ownership is per-author by NIP-33 addressing, and Sam's desktop (which already publishes 30180 as itself from `desktop/src/features/agents/useDesktopCatalogPublisher.ts:14`) and every fleet agent (CLI, `UsersWrite` env-injected per AGENTS.md) can publish. This is the tightest policy that meets the requirement without inventing a new role gate that no comparable kind has. Curation (hide foreign rows) is a reader concern; §3.4 explains why collisions are benign.
- **Read gates: none needed.** Do NOT add the kind to `AUTHOR_ONLY_KINDS`, `P_GATED_KINDS`, `RESULT_GATED_KINDS`, or `SHARED_GATED_KINDS` (`kind.rs:129-171, 217`). Ungated stored kinds are community-readable through the single chokepoint `event_visible_to_reader` (`req.rs:1476-1488`), which is how 30180 is "public-read by design" (`kind.rs:1204-1206`). Both read surfaces — WS REQ and HTTP `POST /query` — funnel through it (`req.rs`; bridge is in the `p_gated_filters_authorized` caller set, `crates/buzz-relay/src/api/bridge.rs`). No tag beyond `d` is required at ingest; no NIP-29 scoping applies.

### 2.4 Envelope validation + deletion

- New `validate_voice_catalog_envelope(event)` at the per-kind call block (`ingest.rs:2781-2794` style), reusing the `single_bounded_d_tag` **structure** with one deliberate difference: **96-char bound instead of 64**. The imported key `pocket:imported:` (16 chars) + 64 hex = 80 chars exceeds the generic 64-char bound (`ingest.rs:1473-1477`), so reusing `single_bounded_d_tag` verbatim would make imported rows unpublishable — this is the kind of detail that surfaces as a mysterious publish failure in step 3 if missed. The validator: exactly one `d`, non-empty, ≤96 chars, no control chars/whitespace (identical rules otherwise). Envelope-only, matching house style: the persona and team-catalog validators check tags, never content (`ingest.rs:1492-1528`); content parsing is the readers' contract.
- **Deletion**: kind 5 with exactly one `a` tag `30181:<author-hex>:<voice-key>` — generic path, zero relay changes. Ingest requires e-or-a count == 1 (`ingest.rs:2704-2716`), `validate_standard_deletion_event` requires the actor to be the target author or the agent's registered owner (`side_effects.rs:237-259` — the `is_agent_owner` branch means an agent's rows are deletable by its owner's key, which is the fleet's actual operating model), and `soft_delete_by_coordinate` guards on `created_at <= deletion_ts` (`event.rs:949-973`). Readers see the row vanish from query results on the next fold (`deleted_at IS NULL` filters throughout `buzz-db/src/event.rs`, e.g. :254). Precedent to copy verbatim: `build_agent_delete` (`agent_events.rs:154-158`) — `a` tag, no `e` tag.

## 3. Content Schema

### 3.1 Full example — imported voice with asset

```json
{
  "version": 1,
  "key": "pocket:imported:60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",
  "displayName": "Azelma studio take",
  "backend": "pocket",
  "contentHash": "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",
  "bundled": false,
  "license": "CC-BY-4.0",
  "source": "Sam's own recording",
  "sourceUrl": null,
  "asset": {
    "sha256": "9f2c07…64-hex…",
    "size": 184354,
    "mimeType": "audio/wav"
  },
  "sampleRate": 32000,
  "durationSeconds": 4.21
}
```

### 3.2 Bundled-preset row (asset-less)

```json
{
  "version": 1,
  "key": "pocket:azelma",
  "displayName": "Azelma",
  "backend": "pocket",
  "contentHash": "60e3d26cdf2efdec5df712152c839928f4d5522821e6554ae11fd96c57ab1026",
  "bundled": true,
  "license": "CC-BY-4.0",
  "source": "VCTK p303_023_enhanced.wav",
  "sourceUrl": "https://huggingface.co/kyutai/tts-voices/blob/323332d33f997de8394f24a193e1a76df720e01a/vctk/p303_023_enhanced.wav",
  "asset": null,
  "sampleRate": null,
  "durationSeconds": null
}
```

**Bundled voices DO get catalog rows.** Web has zero voice knowledge today — `useHuddleAgentSpeech.ts:128` is a bare `SpeechSynthesisUtterance` and `getVoices()` appears nowhere in `web/src` — so the step-2 picker can only enumerate voices the catalog lists. And D5's "let a client KNOW availability" requires catalog keys to exist so clients can match them against local registries: a row with `bundled: true` and no `asset` means "this key is a stock preset; resolve it locally if you have it". The 12 rows' data is exactly the pinned table in `desktop/src-tauri/src/huddle/tts_voice_registry.rs:36-122` (keys `pocket:anna`…`pocket:eve`, pinned sha256, VCTK revision `:7`, URL builder `:124-129`) and the license string already emitted by the desktop (`tts_settings.rs:99`).

### 3.3 Field-by-field rationale and key rules

Serde style: `#[serde(rename_all = "camelCase")]` with `#[serde(default, skip_serializing_if = "Option::is_none")]` on optional fields — the convention of `VoiceRegistryEntry`/`VoiceProvenance` (`tts_settings.rs:50-76`) and `ManagedAgentEventContent` (`agent_events.rs:37-60`). This is deliberate: the desktop reader maps catalog → `VoiceRegistryEntry` almost field-for-field (§6).

| Field | Type | Rationale |
|---|---|---|
| `version` | `u32` | Versioned body like 30180's (`desktop/src/features/agents/desktopCatalogContent.ts:84` convention); readers refuse `version > 1` with the registry-file precedent (`crates/buzz-voice/src/imported.rs:69-74`). |
| `key` | `String` | The stable identity; MUST equal the event's `d` tag. Readers reject mismatches rather than repairing. |
| `displayName` | `String` | Editable label; keys identify audio, not labels (`tts_voice_registry.rs:3-4`, `imported.rs` display_name cap 80 chars at `:140-148` — enforce ≤80 at publish). |
| `backend` | `String` | `"pocket"` only in v1. Mirrors `VoiceRegistryEntry.backend`; leaves room for future backends without a schema break. |
| `contentHash` | `String` | sha256 of the canonical asset (64 lowercase hex). For imported rows this is **the same hash as the local registry key** — `import_path` derives key and hash from one digest (`imported.rs:137-139`), and `valid_identity` enforces `key == "pocket:imported:{content_hash}"` (`imported.rs:304-308`). For bundled rows it is the pinned preset hash. |
| `bundled` | `bool` | Distinguishes "same voice as a bundled preset" (`bundled: true`, key `pocket:<slug>`, no asset) from "imported custom" (`bundled: false`, key `pocket:imported:<hash>`, asset required). This is the answer to "how does a row express same-as-bundled": the key itself, cross-checked by the flag. |
| `license` / `source` / `sourceUrl` | `String` / `String` / `Option<String>` | The license/source column the plan requires before the extra VCTK speakers (bill_boerst, peter_yearsley, …) may join. `sourceUrl` optional; `license` + `source` REQUIRED at publish for every row (bundled rows carry `CC-BY-4.0` + VCTK filename, matching `tts_settings.rs:96-101`). |
| `asset` | `Option<AssetLocator>` | `null` for bundled rows. `{sha256, size, mimeType}` — **the sha256 is authoritative; the URL is derivable**: `GET /media/{sha256_ext}` with the extension matching the stored sidecar (`crates/buzz-relay/src/router.rs:43-44`, `crates/buzz-relay/src/api/media.rs:617-621, 666-683`). So `/media/<sha256>.wav` is derivable from the hash alone *given the canonical `.wav` extension*, which v1 fixes by definition (only canonical WAV is uploadable, §4). A stored absolute `url` is deliberately omitted — it would embed the relay host and break when the origin moves; clients build `relayHttpBaseUrl() + "/media/" + sha256 + ".wav"` (`web/src/shared/lib/relay-url.ts:22-24`). Media GETs are auth-gated (signed kind 24242 — `web/src/shared/api/blossom.ts:287-308`), so the D4/web story already fits the existing client. |
| `sampleRate` / `durationSeconds` | `Option<u32>` / `Option<f64>` | Optional metadata; canonical rows are 32 kHz (`imported.rs:22`), duration derivable but cheap to carry. Bundled presets are Kyutai originals — rates vary, so these stay optional. |

**Key format rules** (enforced at publish; ignored-or-dropped at read):
1. `pocket:eve` is **refused at publish** — exact key, per the identity-test ban (plan Notes). `pocket:eve` remains a locally bundled voice; the ban is on catalog publication and (later) pins, not on local use.
2. `bundled: true` rows MUST have `key == "pocket:<slug>"` matching a known preset in the shared table (§8) and MUST NOT carry an asset.
3. `bundled: false` rows MUST have `key == "pocket:imported:<64 lowercase hex>"` with `key == "pocket:imported:" + contentHash` (the `valid_identity` rule, `imported.rs:304-308`) and MUST carry an asset.
4. No key collisions are possible across authors in the store (coordinate includes pubkey). Two members publishing the *same* key yield two rows — readers prefer their own author's row, then any (§3.4).
5. d-tag grammar is checked at ingest (§2.4); JSON-body field checks are NOT (house style — persona/team-catalog validators are envelope-only, `ingest.rs:1492-1528`).

### 3.4 Rust sketch

```rust
/// JSON body of a kind:30181 voice-catalog event (`crates/buzz-core` or the
/// desktop reader module — see §6/§8 for placement).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogContent {
    pub version: u32,
    pub key: String,
    pub display_name: String,
    pub backend: String,
    pub content_hash: String,
    #[serde(default)]
    pub bundled: bool,
    pub license: String,
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_url: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub asset: Option<VoiceCatalogAsset>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_seconds: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCatalogAsset {
    /// sha256 of the uploaded canonical WAV; the locator is
    /// `{relay-http-base}/media/{sha256}.wav`.
    pub sha256: String,
    pub size: u64,
    pub mime_type: String,
}
```

## 4. Asset Path (Blossom) — including the one real blocker

**Verified blocker:** every upload path rejects audio. `validate_file_content` (`crates/buzz-media/src/validation.rs:195-207`) sniffs with `infer` and returns `DisallowedContentType` for any `audio/*` mime ("audio is rejected until Buzz has an explicit sanitizer and location-metadata validator for its container"). The web client mirrors this ("no audio" in its deny-list comment, `blossom.ts:96-99`), and the CLI hard-codes an image/video-only `ALLOWED_MIMES` (`crates/buzz-cli/src/client.rs:64-70, 1116`). A WAV cannot be published to `/upload` today, by any client.

**Design — a narrow canonical-WAV allowance in buzz-media:**

- New `pub fn validate_voice_reference_wav(bytes: &[u8]) -> Result<(), MediaError>` in `crates/buzz-media/src/validation.rs`: structural RIFF/WAVE check only — `RIFF`/`WAVE` magic, `fmt ` chunk with PCM (1) or IEEE-float (3) encoding, chunk-walk rejecting any metadata-bearing chunk (`LIST`/`INFO`/`ID3`/`bext`/`cue `), size ≤ `max_file_bytes` (checked by the caller already, `validation.rs:176-181`). This is the sanitizer-equivalent for the one format we accept: the rejection rationale is container metadata/location tags, and a header-only PCM WAV has none — the same structural logic `buzz-voice`'s `decode_wav` already implements for parsing (`imported.rs:321-379`), minus decoding.
- Wire it into `validate_file_content`: before the `audio/*` rejection arm, sniffed `audio/wav` passes through `validate_voice_reference_wav` and returns `("audio/wav", "wav")`. All other `audio/*` stays rejected. Serve path needs no change: `serve_inline` stays false for audio (`validation.rs:228-230`), so reference WAVs are `Content-Disposition: attachment` with `nosniff` + CSP (`api/media.rs:687-695, 719-729`) — exactly right for a fetch-and-verify asset, never a render target.
- **Publish-time validation (client side, where the strong rules live):** `buzz voices publish` canonicalizes first through `PocketVoiceLibrary::import_path` (`imported.rs:117-189`) — 2–30 s, 8–96 kHz, ≤25 MB, silence rejection, downmix + resample to 32 kHz PCM16 mono (`imported.rs:17-23, 377-379, 415-418`) — then uploads the canonical bytes. The relay's structural check is a backstop, not the gate.
- `buzz-cli/src/client.rs` `upload_file`: add `"audio/wav"` to `ALLOWED_MIMES` (:64-70) and skip the image-sanitize branch for it (:1124-1141 — that branch already keys on `mime.starts_with("image/")`). The descriptor's `url`/`sha256` return feeds the catalog row (`upload_file` signature at :1100).

**Explicitly the one new security surface in v1** — it widens a deliberate deny-list. Flagged for that reason; the structural validator and its chunk-walk are where the review attention and the mutation tests (§9) belong.

## 5. Relay Changes (exact files/functions)

Four touch points, all additive:

1. **`crates/buzz-core/src/kind.rs`**
   - `pub const KIND_VOICE_CATALOG: u32 = 30181;` with a doc comment in house style (what it is, addressing `(pubkey, kind, d)` with d = voice key, public-read rationale, pointer to this design), placed after the `KIND_DESKTOP_CATALOG` (:308) / `KIND_TEAM_CATALOG` (:336) block.
   - Add to `ALL_KINDS` (:703-835).
   - `const _: () = assert!(is_parameterized_replaceable(KIND_VOICE_CATALOG));` alongside :948-956.
   - Deliberately NOT added to: `AUTHOR_ONLY_KINDS` (:129), `P_GATED_KINDS` (:161), `RESULT_GATED_KINDS` (:144), `SHARED_GATED_KINDS` (:217), `is_relay_only_kind` (:919). Its public-read status then needs no code — it is the default for ungated stored kinds (see `kind.rs:1204-1206` for the 30180 analogue, asserted in tests).
2. **`crates/buzz-relay/src/handlers/ingest.rs`**
   - Import `KIND_VOICE_CATALOG` in the `buzz_core::kind` use block (:17-35).
   - `required_scope_for_kind`: add to the `UsersWrite` arm at :441-444 (next to `KIND_DESKTOP_CATALOG`).
   - `is_global_only_kind`: add to the NIP-AP block at :659-663 (next to `KIND_TEAM_CATALOG | KIND_DESKTOP_CATALOG`).
   - New `fn validate_voice_catalog_envelope(event: &Event) -> Result<(), String>` (near :1523, after `validate_team_catalog_envelope`): exactly one `d` tag, non-empty, ≤96 chars, no control/whitespace — same rules as `single_bounded_d_tag` (`:1453-1485`) with the widened bound and a doc comment explaining why (imported keys are 80 chars; cite `imported.rs:138`). Call site: `if kind_u32 == KIND_VOICE_CATALOG { … }` in the per-kind block at :2781-2794.
3. **`crates/buzz-media/src/validation.rs`** — the WAV allowance (§4). No router, sidecar, or serving changes.
4. **Nothing else.** NIP-33 replacement is generic (`replaceable.rs:552`, keyed `(community, kind, pubkey, d_tag)`); kind-5 deletion is generic (§2.4); read gating for an ungated kind is generic (`req.rs:1476-1488`); COUNT fast-path is safe because the kind is in no gated set (`req.rs:1392-1423`); the `POST /events` and WS paths share this one ingest function (`ingest.rs:2205-2258`, relay-only check at :2205, scope check at :2275-2280). Old relays reject the kind with the stable `restricted: unknown event kind` string (:549) — a clean, handled publish failure for prematurely-deployed clients.

## 6. Desktop Reader

**Design principle: the catalog is a cache overlaid on the existing local registry, inside the existing Tauri command surface. D5's fallback is structural — every failure path returns today's local-only list.**

Current shape (verified): `list_voice_registry` (`tts_settings.rs:344-346`) returns `voice_registry(app)` (:107-132) — bundled rows from `POCKET_VOICES` + imported rows from the device registry — as `Vec<VoiceRegistryEntry>` (:50-76), which already carries `availability` with "downloadable" named in the doc comment as a planned state (:62) and a `provenance` block (:69-76). React surfaces `VoiceSettingsCard.tsx:62` and `ParticipantList.tsx:183` invoke it on open. The mock bridge knows the command (`desktop/src/testing/e2eBridge.ts:11432`).

**New module `desktop/src-tauri/src/huddle/voice_catalog.rs`:**

- `VoiceCatalogContent` (§3.4) + `fn catalog_content_from_event(&nostr::Event) -> Result<VoiceCatalogContent, String>` — serde parse; reject `version > 1`, key/d mismatch, invalid key grammar (mirrors `managed_agent_content_from_event`, `agent_events.rs:140-145`).
- Cache in `HuddleAudioSettingsState` (`tts_settings.rs:41-48`): `voice_catalog: Mutex<VoiceCatalogCache>` where `VoiceCatalogCache { relay_api_base: String, fetched_at: Option<Instant>, rows: Vec<VoiceCatalogRow> }`. **Keyed by `relay_api_base_url_with_override(state)`** (`relay.rs:63`) — a community switch changes the relay URL, the mismatch drops the cache, and no `resetCommunityState()` entry is needed because the state lives Rust-side behind the key check, not in a React module singleton. (Web-side N/A: one community per origin. This satisfies the AGENTS.md community-switch rule with a structural guard instead of a reset-list entry — and if a reviewer prefers the list anyway, adding a reset fn is one line.)
- `#[tauri::command] pub async fn list_voice_catalog(app: AppHandle, state: State<'_, AppState>) -> Result<Vec<VoiceRegistryEntry>, String>`:
  1. If the cache is fresh (TTL 5 min) and matches the relay base, skip to step 4.
  2. Else spawn `tokio::task::spawn` refresh: `query_relay(state, &[json!({"kinds":[KIND_VOICE_CATALOG],"limit":500})])` (`relay.rs:360-389` — NIP-98-authed `POST /query`, the same one-shot pattern every desktop relay read uses), parse rows, wholesale-replace the cache (a full-result fold means kind-5 deletions propagate on every refresh — never a union that resurrects deleted rows), then `Emitter::emit("voice-catalog-updated")` so open surfaces can re-list.
  3. **Never block the picker on the network**: return immediately from cache-or-local; refresh lands asynchronously. Any query error is logged and swallowed — the cache simply stays stale/empty.
  4. Merge: start from `voice_registry(app)`; for each catalog row, if `key` matches a local bundled/imported entry, keep the LOCAL row (local availability wins — this also makes a forged `pocket:eve` row inert on desktop, since the bundled row shadows it); else append as `VoiceRegistryEntry { availability: "downloadable", provenance: from catalog (license/source/source_url/content_hash), reference_file: None, fallback_key: Some(MARY) }`. Rows failing validation are dropped, not fatal.
- Register in `lib.rs` invoke handler (the block at `lib.rs:826`).
- **React changes, minimal:** `VoiceSettingsCard.tsx:62` and `ParticipantList.tsx:183` call `list_voice_catalog` instead; optionally listen once for `voice-catalog-updated` to re-invoke. No new React module state, so no `useCommunityInit.ts` change. `list_voice_registry` stays registered (e2e bridge + any legacy callers).

Data flow: `UI open → list_voice_catalog → local registry (bundled + imported) ⊕ cached catalog rows → Vec<VoiceRegistryEntry>` with `→ spawn(query_relay POST /query {kinds:[30181]}) → parse+validate → cache replace → emit → UI re-lists`.

Step-3 note (not built now): `sync_agent_voice_assignments` already receives `&mut HuddleState`, which carries `parent_channel_id` (`state.rs:49`) — the pin lookup threads through the signature that exists; nothing in this design blocks it.

## 7. Web Reader

Follows the user-status feature end to end (`web/src/features/user-status/hooks.ts` is the chosen simple precedent: typed lib module + live subscribe hook + published kind constant citing `kind.rs`).

**New feature dir `web/src/features/voice/`** (matches the feature-dir list: no `voice` feature exists yet):

- **`lib/voiceCatalog.ts`** — `export const KIND_VOICE_CATALOG = 30181;` with the citation comment (pattern: `user-status/lib/statusEvent.ts:7,33`); the `VoiceCatalogRow` type mirroring §3; `parseVoiceCatalogEvent(event): VoiceCatalogRow | null` (version gate, key/d match, key grammar, eve-rows dropped here too — on web there is no local registry to shadow a forged `pocket:eve` row, so the reader is the only guard); `reduceVoiceCatalogEvents(events): Map<key, row>` (fold by `d`, LWW by `created_at` — the `reduceStatusEvents` pattern, `statusEvent.ts`); `assetUrl(row, base)` = `base + "/media/" + row.asset.sha256 + ".wav"`.
- **`hooks.ts`** — `useVoiceCatalog(): { rows: VoiceCatalogRow[]; ready: boolean }`:
  ```ts
  useEffect(
    () =>
      session.subscribe(
        { kinds: [KIND_VOICE_CATALOG], limit: 500 },
        { onEvent: (event) => setEvents((prev) => [...prev, event]) },
      ),
    [session],
  );
  ```
  One REQ covers initial read + live fan-out (user-status comment, `hooks.ts:88-91`: "the relay answers with the stored replaceable events, then keeps the subscription open"). The filter names `kinds` explicitly (p-gate safe, `req.rs:1290-1324`). Auth is the NIP-42 session (`useRelaySession` from `web/src/shared/api/RelaySessionProvider.tsx`) — the same layer `blossom.ts` signs media GETs against.
- **No module-level caches** → nothing for a web community-reset list (web has none; one community per origin). If a downloaded-bytes cache is ever added, it goes through `fetchSignedBytes` (`blossom.ts:317-332`) — raw bytes for sha256 verification, deliberately not the object-URL cache.
- v1 web surface = this module + hook only; the picker UI and `.voice` wiring are step 2 (`useHuddleAgentSpeech.ts:128` stays untouched).

## 8. CLI Writer (`buzz voices`)

Per AGENTS.md ("agent-facing operations go in `buzz-cli` … wire the call in `client.rs`"). All plumbing exists: `client.query` (:767), `client.submit_event` (:863), `client.upload_file` (:1100), `client.download_media` (:1252).

**Shared preset table — `crates/buzz-voice/src/bundled.rs` (new):** `pub struct BundledVoicePreset { key, display_name, upstream_vctk_file, sha256 }` + `pub const POCKET_PRESETS: [BundledVoicePreset; 12]` transcribed from `tts_voice_registry.rs:36-122` (VCTK revision constant moves here too; the desktop's `source_url` format `:124-129` stays desktop-side). `buzz-voice` is already the shared voice crate (`desktop/src-tauri/Cargo.toml:117`); the CLI gains the same dependency. **Drift guard:** a new desktop test asserts `POCKET_VOICES` keys+hashes == `POCKET_PRESETS` (desktop can see `buzz_voice_pkg`; the workspace exclusion only means the test runs under `--manifest-path desktop/src-tauri/Cargo.toml`, AGENTS.md gotcha 5). Desktop's registry file is otherwise untouched.

**`crates/buzz-cli/src/commands/voices.rs` (new)** + clap enum in `lib.rs` (registered like `Cmd::Upload` at `lib.rs:2119-2120`, subcommand list at :2270):

- `buzz voices list [--author <hex>]` → `client.query(&json!({"kinds":[30181], …"authors": …}))`; print sig-stripped JSON arrays per CLI convention.
- `buzz voices publish --file <wav> --name <label> --license <str> --source <str> [--source-url <url>]` → canonicalize via `PocketVoiceLibrary::import_path` (a temp library dir; the canonical bytes + hash are what we want, `imported.rs:117-189`) → `upload_file` the canonical WAV → build kind-30181 event (`d` = `pocket:imported:<hash>`, body per §3.1 with `asset.sha256` = the descriptor's sha256) → `submit_event`. Refusals: missing `--license`/`--source`; any key that is not `pocket:imported:<its own hash>`.
- `buzz voices publish-bundled` → 12 asset-less rows from `POCKET_PRESETS`, license `CC-BY-4.0`, `sourceUrl` built from the shared VCTK revision. **Skips `pocket:eve` explicitly and prints that it did.**
- `buzz voices remove --key <key>` → kind-5 `a` tag `30181:<self-hex>:<key>` (verbatim `build_agent_delete` shape, `agent_events.rs:154-158`).
- **Eve refusal** lives in the dispatch layer as a named guard fn (`fn ensure_publishable_key(key: &str) -> Result<(), CliError>`) called by both publish paths — one place, one test.

## 9. Test Plan (per mechanism, named, mutation-provable)

Fleet rule: each test below is paired with the mutation that must make it fail. Runner facts verified: root workspace tests via `just test-unit` / `just test` (Postgres+Redis for integration, AGENTS.md "Quality Gates"); desktop crate excluded from the root workspace — `cargo test --manifest-path desktop/src-tauri/Cargo.toml` (AGENTS.md gotcha 5); web runner is node's built-in test runner over `src/**/*.test.mjs` (`web/package.json:20`); e2e relay tests live in `crates/buzz-test-client/tests/` with the `RELAY_URL=… -- --ignored` invocation (`e2e_team_catalog.rs:15-19`).

| Mechanism | Test file + name | Mutation that must fail it |
|---|---|---|
| Kind registry integrity | `crates/buzz-core/src/kind.rs` tests — existing `no_duplicate_kind_values` (:992) + new `voice_catalog_is_public_parameterized_replaceable` (asserts `is_parameterized_replaceable(30181)`, `!is_relay_only_kind`, absent from all four gated sets) | Change the constant to a colliding value → duplicate test fails; add it to `SHARED_GATED_KINDS` → new test fails |
| Ingest scope + global-only | `crates/buzz-relay/src/handlers/ingest.rs` tests module — `voice_catalog_requires_users_write_and_is_global_only` (style of :3904-4005) | Remove the kind from `required_scope_for_kind`'s UsersWrite arm (kind rejected) or from `is_global_only_kind` (a stray `h` tag channel-scopes it) → respective assertion fails |
| Envelope validation incl. 96-char bound | `ingest.rs` tests — `voice_catalog_envelope_rejects_duplicate_empty_overlong_d` and `voice_catalog_accepts_full_imported_key_d` (80-char `pocket:imported:<64hex>` accepted) | Delete the validator call site (:2781-2794 block) → first test fails; "reuse" `single_bounded_d_tag` (64-char bound) → second test fails — this is the test that pins the one non-obvious decision in §2.4 |
| WAV allowance | `crates/buzz-media/src/validation.rs` tests — `voice_reference_wav_accepts_header_only_pcm`, `voice_reference_wav_rejects_metadata_chunks` (LIST/INFO/bext), `validate_file_content_still_rejects_mp3_and_other_audio` | Accept a `LIST` chunk → second test fails; widen the exception to all `audio/*` → third test fails; revert §4 → first test fails |
| Schema/key rules | `crates/buzz-voice/src/bundled.rs` tests — `preset_table_shape` (12 entries, unique keys, 64-hex hashes) and `publishable_presets_exclude_eve`; `imported.rs`-style content tests for `VoiceCatalogContent` round-trip + `key == "pocket:imported:"+hash` enforcement | Corrupt one hash in the table → shape test fails; remove the eve filter → exclusion test fails |
| CLI eve refusal | `crates/buzz-cli/src/commands/voices.rs` unit test — `voices_publish_refuses_eve_key` | Delete the `ensure_publishable_key` guard → test fails |
| Desktop merge/fallback | `desktop/src-tauri/src/huddle/voice_catalog.rs` tests (run with `--manifest-path desktop/src-tauri/Cargo.toml`) — `catalog_rows_merge_without_shadowing_local_availability`, `relay_error_returns_local_registry_unchanged`, `deleted_rows_drop_on_full_refresh`, `bundled_presets_match_shared_table` (desktop↔buzz-voice drift guard) | Make merge let a catalog row override a bundled row's availability → first fails; make the query-error path return only cached rows → second fails; make cache refresh union instead of replace → third fails; edit either preset table → fourth fails |
| Web reader fold | `web/src/features/voice/lib/voiceCatalog.test.mjs` (node --test, `.test.mjs` per `statusEvent.test.mjs`) — `reduce folds by key with last write wins`, `parse rejects version mismatch and key d mismatch`, `parse drops eve rows` | Flip the fold to first-wins → first fails; drop the version check → second fails; remove the eve filter → third fails |
| End-to-end wire | `crates/buzz-test-client/tests/e2e_voice_catalog.rs` (new, modeled on `e2e_team_catalog.rs`): publish → REQ roundtrip returns the row for a foreign reader (public-read proof); kind-5 `a`-tag removal makes it disappear; overlong/duplicate d rejected; a member's row is readable by another member (community-global proof). Runs under `just test` with Postgres+Redis. | Any relay-side regression in §5 surfaces here; e.g. removing `UsersWrite` arm membership fails the publish step, removing the global-only entry fails the foreign-member read |

`just ci` is the pre-merge gate (AGENTS.md); commits carry `-s` (DCO, AGENTS.md :145).

## 10. Rollout + Compat

| Artifact | Contents | Deploy vehicle | Constraint |
|---|---|---|---|
| Relay image | kind.rs + ingest.rs + buzz-media WAV path | Container recreate riding Sam's restart window (same window as the staged `extra_hosts` change, buzz main `1b39b80af` — plan EXECUTION LOG) | **Must land before any publish works.** Reads of a kind an old relay rejects simply return nothing. |
| CLI binary | `buzz voices` + client.rs WAV upload | `cargo build --release -p buzz-cli`; fleet agents pick it up per-agent | Safe to ship before the relay deploys: `list` returns empty, `publish` fails with the stable `restricted: unknown event kind` NOTICE (ingest.rs:549) — a handled error, not a crash |
| Web bundle | `features/voice/` reader | rsync-only, no recreate | Same: pre-relay it renders an empty catalog; post-relay it fills. Never restarts anything |
| Desktop app | voice_catalog.rs + two React call sites | App release/bundle swap — **Sam's call, never ours** | Reader-only; ships last without blocking anything |

**Old-client behavior when they see the kind: verified inert.** Old clients never construct a filter containing 30181, and relay fan-out is filter-driven, so unknown kinds produce zero traffic change for them (no client ever receives what it never asked for). Old *relays* reject the kind at ingest — that is why the relay image is the only artifact with a real ordering constraint, and it is additive: nothing existing changes behavior. Web and CLI can deploy in any order relative to each other; desktop is independent. Sequencing recommendation: relay (window) → CLI + web → seed `publish-bundled` → desktop at its leisure.

## 11. Explicitly Out of Scope (schema hooks noted)

- **Pins (step 3, D2):** relay events keyed `(channel-or-DM id, agent pubkey) → voice key`. Hook: voice keys are stable strings in a versioned schema — pins reference them by value; `HuddleState.parent_channel_id` (`state.rs:49`) is already in scope at the assignment site.
- **Web voice picker + `.voice` wiring + D4 proxy route (step 2):** the reader (§7) is the data source; `useHuddleAgentSpeech.ts:128` untouched. Hook: `assetUrl()` + `bundled: true` rows give the picker its list; the 6300 pocket-tts service maps bundled names.
- **Download-on-demand:** schema enables it (asset sha256 → derivable signed-GET URL, `availability: "downloadable"` already named at `tts_settings.rs:62`) but no client downloads in v1.
- **Extra VCTK speakers** (bill_boerst et al. on the 6300 service): they join later via `buzz voices publish` once someone attaches license/source — the column now exists. Seed data with licenses already gathered: `~/.buzz/RESEARCH/VOICE_CATALOG_SEED_2026-09-15.md`.
- **Desktop publish UI, web upload, mobile:** v1 publishing is CLI-only.

## 12. Open Questions for the Owner

1. **Kind number 30181** — free, adjacent to the NIP-AP family; confirm or redirect.
2. **Any-member publish (`UsersWrite`)** is recommended — it is what every comparable kind actually enforces, and fleet agents need it. If Sam wants owner-only rows, that is a NEW role check in `validate_voice_catalog_envelope`'s call path (precedent: the 44200 ownership check, `ingest.rs:2740-2773`) — cheap to add now, impossible to add later without an orphaned-row policy.
3. **buzz-media WAV allowance (§4)** widens a deliberate deny-list; it is the one security-review-worthy change. Alternative if Sam prefers zero media changes: v1 ships bundled rows only and imported-voice assets wait — but that defers the plan's "asset path on media" out of step 1.
4. **Bundled-preset table home** (§8): shared `buzz-voice::bundled` + a desktop drift-guard test (recommended), versus duplicating the table in the CLI.
