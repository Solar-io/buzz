# Web huddle: docked + floating voice UI, per-channel voice, duplex mode

Requested by Sam, 2026-09-18. Web client (`web/`) only. The relay, the STT
bridge (`com.dev.buzz-stt-bridge`, port 6360, Parakeet) and the TTS bridge
(`com.dev.buzz-tts-bridge`, port 6365, Pocket + ElevenLabs) are unchanged.

Sam's answers to the design questions (verbatim intent):

1. The voice chosen in Settings is the DEFAULT. A per-DM / per-channel
   override must be settable from inside the huddle.
2. Half-duplex is the default: while the agent talks, the mic is muted; when
   she is done the mic is hot again. Barge-in: the mic stays hot and speaking
   cuts her off. A switch flips between them.
3. Floating mode is an IN-PAGE panel (no popup window).
4. The docked bar stays docked to the DM / channel it was started from.
5. Browser `speechSynthesis` ("on-device") voices are dropped from the UI.
   Engines offered: Pocket and ElevenLabs only.

Constraints accepted by Sam: speaker selection needs `setSinkId` (Brave /
Chrome / Edge; Safari and Firefox get a disabled menu with a note). Agent
audio on web is local playback through the TTS bridge, not room broadcast.

## What exists on this branch (do not rebuild)

- `ChannelHeader.tsx` — "start a huddle" (`HuddleIndicator`) on every
  non-ephemeral channel, DMs included. Keep.
- `features/huddle/ui/HuddleBar.tsx` — the current join/in-call bar, mounted
  in `app/routes/repos.tsx:905` ONLY when the current channel is the huddle's
  ephemeral channel. Hooks: `useHuddleAudio` (mic capture, uplink, peers,
  input devices, open-mic / push-to-talk, mute), `useHuddleVoiceMode`
  (STT bridge → finals published via `send` with the `[voice] ` marker and
  agent p-tags), `useHuddleAgentSpeech` (agent replies → TTS bridge → local
  playback; `speakRoute` picks engine from the agent's published kind-30182
  selection or the derived Pocket default), reactions, add-agent, roster.
- `features/voice/` — kind-30181 catalog, kind-30182 selection,
  `VoiceSettingsCard` + `VoicePickerDialog` (lists pocket + eleven + on-device
  in one flat list with Preview through the real bridge).
- `lib/huddleVoicePersistence.ts` — sessionStorage reload survival.
- Echo suppression already holds finals that land while the avatar speaks and
  drops ones matching her recent utterances (`lib/voiceTranscript.ts`).

## Scope checklist (every item is required; none may be self-descoped)

### S1. Lift the call out of the route — `HuddleSessionProvider`
- New provider mounted once above the routes (next to the other app-level
  providers in `main.tsx` / `App` shell). It owns ONE active huddle call:
  `useHuddleAudio`, `useHuddleVoiceMode`, `useHuddleAgentSpeech`, reactions,
  roster, the voice-persistence coupling now inside `HuddleBar`, keyed by
  `{huddleChannelId, parentChannelId}`.
- The call survives route changes. Leaving is explicit (Leave button) or the
  relay ending the huddle.
- `HuddleBar` becomes a thin join surface on the huddle channel (join button,
  ended/unlinked gating, pre-join mic picker) and the in-call UI moves to the
  dock (S2). Keep every existing behaviour listed above working; move code,
  do not rewrite semantics. File-size gate is 1000 lines/file — split.
- `send` for voice finals: the provider needs the huddle channel's send. Use
  the same `useMessageActions`-style path the route uses, constructed for the
  huddle channel id inside the provider (check how `repos.tsx` builds `send`
  and reuse the underlying hook).

### S2. Docked bar (screenshot 1)
- `HuddleDock.tsx`, rendered at the BOTTOM of the channel view (below the
  composer) whenever a call is active AND the current channel is either the
  huddle's ephemeral channel or its parent channel. On any other channel the
  dock is NOT shown (Sam: "stays docked to that dm or channel") but the call
  keeps running; a small pill in the sidebar/header ("In huddle · #name",
  click to go back) is required so the call is never invisible.
- Layout, left → right, matching the desktop screenshot:
  - Mic button (red background + slashed icon when muted, neutral when live)
    with a chevron split-button to its right that opens the MIC device menu.
  - Speaker button (mute/unmute agent + peer playback) with a chevron
    split-button opening the SPEAKER (audiooutput) device menu.
  - Participant avatar stack: self + audio peers + roster agents (agents added
    to the huddle appear even when they are not audio peers). Speaking ring
    on whoever is talking (peers via `huddle.speaking`, agents via
    `speech.speechActivity`, self via `micLevel`).
  - Centre group: emoji reaction; voice-mode toggle (STT on/off — the
    "captions" icon in the screenshot, highlighted when on); add-agent
    (robot); huddle settings (gear, opens S4).
  - Right: float/dock toggle icon; red Leave button.
  - Open-mic / push-to-talk selector and the interim transcript stay
    available (put them inside the mic chevron menu and as a small caption
    line respectively).
- Keep all existing `data-testid`s where the control still exists
  (`huddle-mute`, `huddle-ptt`, `huddle-input-mode`, `huddle-react`,
  `huddle-voice-mode`, `huddle-agent-speech`, `huddle-add-agent`,
  `huddle-peer`, `huddle-join-audio`, `huddle-device`, `huddle-ended`,
  `huddle-reconnecting`, `huddle-voice-interim`). Add `huddle-dock`,
  `huddle-mic-menu`, `huddle-speaker-menu`, `huddle-speaker-device`,
  `huddle-float-toggle`, `huddle-settings`, `huddle-participant`.

### S3. Floating panel (screenshot 2)
- `HuddleFloatingPanel.tsx`: an in-page draggable panel (position persisted in
  localStorage, clamped to the viewport, default bottom-right) toggled by the
  dock's float button; the dock collapses while floating and the panel's own
  bottom bar carries the identical controls (share one `HuddleControls`
  component between dock and panel).
- Contents top → bottom: participant cards grid (avatar, name, speaking ring,
  per-agent ⋮ menu with "Remove from huddle" if the roster hook supports it,
  else omit the menu); "Huddle chat" header card; the huddle channel's
  timeline (reuse the existing timeline component for the huddle channel —
  voice transcripts and agent replies already land there); the composer for
  the huddle channel; the controls bar.
- The panel is visible on EVERY route while floating (it is the point of
  floating), unlike the dock.
- Escape / the dock icon returns to docked.

### S4. Huddle settings popover (gear) — per-channel voice + duplex
- Engine segmented control: Pocket | ElevenLabs. Voice list filtered to the
  chosen engine only (`pocketVoiceOptions(rows)` / `elevenVoiceOptions`), each
  row with Preview (reuse the bridge preview code from `VoicePickerDialog` —
  extract it to a shared helper, do not copy it).
- "Use default (Settings)" resets the override.
- Duplex switch: Half-duplex (default) | Barge-in, with one-line descriptions.
- Persistence: localStorage, keyed by the PARENT channel id
  (`buzz.huddle.prefs.<parentChannelId>`), value
  `{ voice?: {engine:"pocket"|"eleven", key}, duplex: "half"|"barge" }`.
  Pure module `lib/huddlePrefs.ts` with load/save/resolve + tests.
- Resolution order for the voice an agent is rendered with in this browser:
  per-channel override → the agent's published kind-30182 selection → derived
  Pocket default. Wire it into `speakRoute` / `useHuddleAgentSpeech` via an
  injected `voiceOverride` so the existing selection tests keep passing.
- Settings page: `VoicePickerDialog` gets the same engine-first layout and
  DROPS `localVoiceOptions` and the on-device preview branch. Keep the
  `local-synth` variant in the type/parser for old published rows, but a
  stored local-synth selection now resolves like "no selection" (derived
  Pocket default) — document that in `describeSelection`.

### S5. Duplex behaviour
- Half-duplex: while `speech.speaking` (or within the existing echo tail),
  the mic is HELD: `micLive` is false for both the STT bridge and the uplink
  (disable the track exactly like mute, but driven by a separate `held`
  flag so the user's own mute state is untouched and restored). The dock
  shows "Mic paused while <agent> speaks". When speech ends, mic returns to
  its prior state.
- Barge-in: mic stays hot. When the STT bridge delivers an interim or final
  with real speech while the agent is speaking, cancel the agent's playback
  immediately (`useHuddleAgentSpeech` needs an `interrupt()` that stops the
  bridge audio source and clears the queue) and let the final publish through
  the existing echo check (a final that IS an echo must not interrupt —
  interrupt on interim text only after `isSpeaking(micLevel)` has been true
  for ≥ 300 ms, to avoid echo triggering it on speakers).
- Pure reducer `lib/duplexGate.ts` (`nextMicHold(state, event)`) with tests
  covering: half-duplex holds on speech start and releases on end; barge-in
  never holds; barge-in interrupt fires only after the debounce; user mute
  outranks everything.

### S6. Device pickers
- Mic: `enumerateDevices` audioinput; switching MID-CALL must replace the
  uplink track without leaving (extend `selectDevice` in `useHuddleAudio`).
  Persist the chosen deviceId in localStorage; re-apply on the next join.
- Speaker: audiooutput list; apply with `AudioContext.setSinkId` (playback
  context for peers and for agent TTS — both) and persist. When `setSinkId`
  is unsupported, render the menu disabled with "Speaker selection needs
  Brave, Chrome or Edge". `devicechange` refreshes both lists.
- `lib/audioDevices.ts` pure helpers (label fallback, default detection,
  persistence) + tests.

### S7. Transcript + agent text/audio (verify, mostly exists)
- Your speech → `[voice]` message in the huddle channel (exists).
- Agent reply → message in the huddle channel (exists) AND local audio via
  the resolved voice (S4) subject to duplex (S5). Typing in the composer works
  at the same time as voice — confirm nothing in the dock steals focus or
  the Space key from the composer (the current bar binds Space for PTT only
  while the bar has focus; keep that).

## Quality gates (all must pass; report the outputs)
- `cd web && pnpm test` (the ONLY supported runner; assert the test COUNT
  went up by the new tests, not just "pass").
- `cd web && pnpm typecheck && pnpm check` (biome + px-text + pubkey checks).
- `cd web && pnpm check:file-sizes` — no file over 1000 lines.
- `just ci` has pre-existing drift on untouched files under hermit 1.95; run
  the web lanes individually as above and say so.
- Every new pure module has a test that was SHOWN TO FAIL against a broken
  mechanism (name the test and the mutation in the report).
- Live check: `cd web && pnpm dev` (or the existing dev relay at
  buzz-dev.internal if the web app is served there) — open a DM, start a
  huddle, join, confirm the dock renders at the bottom with mic/speaker
  split-buttons, open settings, switch engine and see only that engine's
  voices, float and drag the panel. Report what was and was not exercised.

## Commits
Conventional commits, `git commit -s`, one per scope item where practical,
on this branch (`claude/buzz-huddle-voice-chat-2c27c3`). Do not write merge
or deploy status anywhere.
