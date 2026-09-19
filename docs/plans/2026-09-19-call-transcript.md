# Visible text in DM voice calls

Sam authorized implementation and deployment after the missing-transcript
diagnosis on 2026-09-19. Voice messages already exist in the temporary call
room; the attached DM dock needs a reader for that room.

- [x] Shared call-chat reader shows completed human finals and agent replies.
- [x] Compact read-only transcript appears above the DM dock controls.
- [x] Floating chat shares the reader and retains its composer.
- [x] Call rows expose no DM-scoped action toolbar or inert thread actions.
- [x] Dock/float/navigation/hangup preserve the active-call visibility contract.
- [x] Desktop and narrow-phone layouts keep text readable and controls reachable.
- [x] Real DOM assertions fail on the old UI and pass on the corrected UI.
- [x] Scheduled voice gate requires both readable rows independently of audio.
- [x] Full package tests, builds, integration, and served-bundle checks complete.

This is active-call display: leaving the call removes its panel. It does not
copy room events into the DM, change audio transport, or add persistent call
history to the DM. The room's original messages remain on the relay.

## Implementation and evidence

App implementation: `5a48fd461ec1d7e5971670bdc6f3b60212293a90`, bundle
`index-CIm4Dein.js`. The full web suite ran 2,571 tests with no failures;
the production build and TypeScript checks passed.

The previous served bundle passed voice delivery but failed both completed
message-row assertions. Corrected served checks passed at 1500×950,
390×844, and 375×812. Each checks the actual signed human text and a
threaded agent reply in the dock and floating view, scrolling each row into
the transcript viewport. Viewport dimensions are asserted independently of
report filenames. Call controls remain reachable, no horizontal overflow
appears, the DM stays selected, and Leave removes the call panel.

Receipts and inspected screenshots are retained in
`logs/call-transcript-20260919/`, especially `served-cim-desktop.json`,
`served-cim-390.json`, `served-cim-375.json`, and `FINAL_VERDICT.md`.
Phone evidence uses headed Chromium at narrow viewports, not a physical
iPhone or native Safari run.

The shared voicecheck gate independently requires readable human and agent
rows and propagates browser UI failures/nonzero exits. Its 70 unit tests
passed; disabling the DOM guard made the named regression test fail. The
old served UI failed the corrected live gate for both missing text fields;
the new served UI passed in report `20260919T134812Z-gate`.
