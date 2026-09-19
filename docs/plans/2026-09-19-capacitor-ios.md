# Buzz iOS: shared web application with native services

Sam authorized implementation on 2026-09-19. The primary interface is the existing web client, packaged with Capacitor; native services provide push and background huddles. Agent/harness management is excluded. Existing Flutter and PWA work remains independently owned and must not be overwritten.

## Scope and completion checklist

An item is complete only with implementation and the relevant verification. Device-only evidence remains explicitly outstanding until collected.

- [ ] Architecture: native/web interfaces, identity/origin boundaries, reuse map, failure behavior.
- [ ] Reproducible Capacitor iOS shell with bundled web assets and repository build scripts.
- [ ] Explicit relay configuration for bundled origin; authenticated HTTP/media/WS access, safe navigation and deep links.
- [ ] Existing identity enrollment/pairing and remembered identity integrated with native secure storage; lock/forget behavior.
- [ ] Shared channel/DM read/send, new DM, new channel, member actions, drafts, uploads and search retained.
- [ ] Shared forum/daily alerts, Inbox/decision cards, reminders, projects/issues, settings and Thinking retained.
- [ ] Phone message action affordances and compact composer/header/navigation; no browser regressions.
- [ ] Native push capability, token enrollment through existing gateway contract, opt-in/out and token rotation.
- [ ] Notification cold/warm launch navigates to the intended conversation/thread after authentication.
- [ ] Native huddle media engine reusing the existing Swift implementation.
- [ ] Native huddle transport/auth/reconnect and session ownership independent of WebView JavaScript.
- [ ] Human/agent voice path accounted for end to end while backgrounded; mute/leave/routes/interruption behavior.
- [ ] Foreground UI rehydrates native call state; teardown on explicit leave/logout/community change.
- [ ] Build and full affected-package checks, meaningful failure/mutation evidence, simulator workflow.
- [ ] Real-device two-way lock/background audio and APNs notification-to-thread proof.
- [ ] Signed build/package and installation/release instructions; distribution authorization requirements reported precisely.
- [ ] QA findings resolved, final verifier, scoped conventional commits, integration into canonical checkout and worktree cleanup.

## Initial evidence

- Initial base: `1199b86a67` (2026-09-19 canonical main).
- Isolated branch: `codex/buzz-ios-capacitor-20260919`.
- Prior analysis: `~/.buzz/RESEARCH/BUZZ_WEB_IOS_FUNCTIONALITY_ANALYSIS_2026-09-19.md` and `BUZZ_IOS_WRAPPER_RECOMMENDATION_2026-09-19.md`.
- Native audio engine: `mobile/ios/Runner/HuddleAudioEngine.swift`; Flutter bridge `HuddleMediaPlugin.swift`; transport/session currently Dart under `mobile/lib/shared/huddle/`.
- Native push enrollment: `mobile/ios/Runner/AppDelegate.swift` / `mobile/lib/shared/push/`; existing gateway/relay contract must be reused.
- Web interface origin, auth, background voice and push wiring need adaptation; an installed icon alone is not acceptance.
- No server restart, production deployment, destructive operation, or other session worktree mutation is part of implementation by default.

## Validation record

Evidence goes in this worktree's `logs/verification.log` and focused supporting artifacts. Test output must reflect actual executed checks. Physical-device availability observed during preflight is not a completed runtime test.
