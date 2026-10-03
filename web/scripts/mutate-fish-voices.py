"""Run reversible mechanism mutations with the real web test loader.

Run from the activated repo root: python3 web/scripts/mutate-fish-voices.py.
Refuses dirty targets; restores exact committed bytes in every exit path.
"""
import json
import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEB = ROOT / "web"
LOGS = ROOT / "logs" / "fish-mutations"
LOGS.mkdir(parents=True, exist_ok=True)
V = "src/features/voice/"
H = "src/features/huddle/"
RUNTIME = V + "lib/fishVoice.test.mjs"
OPTIONS = V + "ui/voicePickerOptions.test.mjs"
MODEL = V + "lib/voiceLibraryModel.test.mjs"
API = V + "lib/voiceLibraryApi.test.mjs"
HOOKS = V + "voiceLibraryHooks.test.mjs"
SURFACES = V + "ui/voiceSurfaces.test.mjs"
AGENTS = V + "ui/AgentVoicesCard.test.mjs"
PREVIEW = V + "ui/voicePreview.test.mjs"
PLAYER = V + "useAgentSpeechPlayer.test.mjs"
mutations = []


def add(name, source, old, new, spec):
    mutations.append((name, source, [(old, new)], (spec,)))


add("fish-parse", V + "lib/agentVoiceSelection.ts", 'content.engine === "fish"', "false", RUNTIME)
add("fish-grammar", V + "lib/agentVoiceSelection.ts", "{16,64}", "{1,100}", RUNTIME)
add("fish-precedence", V + "lib/voicePrecedence.ts", "  return selection;", '  return selection.engine === "fish" ? undefined : selection;', RUNTIME)
add("fish-summary-preview", V + "lib/agentVoiceSummary.ts", 'selection?.engine === "fish"', "false", RUNTIME)
add("fish-display-name", V + "lib/chatterboxRoster.ts", 'return "Fish Audio";', 'return "Wrong engine";', RUNTIME)
add("fish-bridge-request", H + "lib/bridgeSpeech.ts", 'selection.engine === "fish"', "false", RUNTIME)
add("fish-speech-disposition", H + "lib/huddleAgentSpeech.ts", 'selected.engine === "fish"', "false", RUNTIME)
add("fish-huddle-prefs", H + "lib/huddlePrefs.ts", 'candidate.engine !== "fish"', "true", RUNTIME)
add("sort-every-engine", V + "ui/voicePickerOptions.ts", "return sortVoiceOptions(rows);", "return rows;", OPTIONS)
add("sort-chatterbox", V + "ui/voicePickerOptions.ts", "return sortVoiceOptions(rows);", 'return engine === "chatterbox" ? rows : sortVoiceOptions(rows);', OPTIONS)
add("sort-numeric", V + "ui/voicePickerOptions.ts", "numeric: true", "numeric: false", OPTIONS)
add("fish-tabs", V + "ui/voicePickerOptions.ts", '  "fish",', "", SURFACES)
add("fish-initial-tab", V + "ui/voicePickerOptions.ts", ' || current?.engine === "fish"', "", OPTIONS)
add("fish-option-equality", V + "ui/voicePickerOptions.ts", 'a.engine !== "fish"', "true", OPTIONS)
mutations.append(("sort-pinned-voice", V + "ui/voicePickerOptions.ts", [("  return [\n    {", "  return sortVoiceOptions([\n    {"), ("    ...options,\n  ];", "    ...options,\n  ]);")], (OPTIONS,)))
add("pin-settings-dialog", V + "ui/VoicePickerDialog.tsx", "? current\n          : undefined", "? undefined\n          : undefined", SURFACES)
add("pin-huddle-popover", H + "ui/HuddleSettingsPopover.tsx", "? prefs.voice : null", "? null : null", SURFACES)
add("library-post-payload", V + "lib/voiceLibraryApi.ts", 'nip98Headers(url, "POST", { body })', 'nip98Headers(url, "POST", {})', API)
add("library-delete-auth", V + "lib/voiceLibraryApi.ts", 'nip98Headers(url, "DELETE")', 'nip98Headers(url, "GET")', API)
add("library-forbidden-message", V + "lib/voiceLibraryApi.ts", "Only the voice-library admin may add or remove voices.", "Unknown error.", API)
add("library-engine-url", V + "lib/voiceLibraryApi.ts", 'voiceLibraryUrl(`/voices/${engine}`), { signal }', 'voiceLibraryUrl(`/voices/eleven`), { signal }', HOOKS)
add("library-public-query", V + "lib/voiceLibraryApi.ts", "encodeURIComponent(q)", 'encodeURIComponent("")', API)
add("fish-url-input", V + "lib/voiceLibraryModel.ts", 'url.hostname === "fish.audio"', 'url.hostname === "disabled.test"', MODEL)
add("usage-local-rooms", V + "lib/voiceLibraryModel.ts", "for (const row of overrides)", "for (const row of [])", MODEL)
add("usage-card-wiring", V + "ui/VoiceLibraryCard.tsx", "localVoiceOverrides(storage)", "[]", SURFACES)
add("library-refresh", V + "lib/voiceLibraryRevision.ts", "version += 1", "version += 0", HOOKS)
add("library-admin-hint", V + "hooks.ts", "admins.some(", "[].some(", HOOKS)
add("library-readonly-ui", V + "ui/VoiceLibraryCard.tsx", "const { isAdmin } = useVoiceLibraryAdmin();", "const isAdmin = true;", SURFACES)
add("library-row-sorting", V + "ui/VoiceLibraryRows.tsx", "  return (", "  options.reverse();\n  return (", SURFACES)
add("agent-removed-badge", V + "ui/AgentVoicesCard.tsx", "{missing && (", "{false && (", AGENTS)
add("self-removed-badge", V + "ui/VoiceSettingsCard.tsx", "{missing && (", "{false && (", SURFACES)
add("profile-picker-selection", "src/features/profile/ui/AgentConfigSection.tsx", "current={currentVoice}", "current={undefined}", SURFACES)
add("fish-preview-post", V + "ui/voicePreview.ts", "engine: request.engine", 'engine: "chatterbox"', PREVIEW)
add("fish-player-post", V + "lib/agentSpeechPlayer.ts", "engine: bridgeRequest.engine", 'engine: "chatterbox"', PLAYER)


def run(label, specs):
    command = ["node", "--import", "./test-loader.mjs", "--experimental-strip-types", "--test", "--test-reporter=tap", *specs]
    completed = subprocess.run(command, cwd=WEB, capture_output=True, text=True)
    output = completed.stdout + completed.stderr
    (LOGS / f"{label}.log").write_text(output)
    count = re.search(r"^# tests (\d+)$", output, re.M)
    failed = re.findall(r"^not ok \d+ - (.*)$", output, re.M)
    return completed.returncode, int(count[1]) if count else 0, failed


sources = {source: (WEB / source).read_bytes() for _, source, _, _ in mutations}
dirty = subprocess.run(["git", "diff", "--quiet", "--", *["web/" + source for source in sources]], cwd=ROOT)
if dirty.returncode:
    raise SystemExit("Refusing to mutate dirty source files")
baseline = {}
receipts = []
try:
    for _, _, _, specs in mutations:
        if specs not in baseline:
            result, count, _ = run("baseline-" + Path(specs[0]).stem, specs)
            if result or not count:
                raise RuntimeError(f"Baseline failed: {specs}, count={count}")
            baseline[specs] = count
    for name, source, changes, specs in mutations:
        path = WEB / source
        original = sources[source]
        mutant = original.decode()
        for old, new in changes:
            if mutant.count(old) != 1:
                raise RuntimeError(f"Mutation {name}: expected exactly one anchor, found {mutant.count(old)} for {old!r}")
            mutant = mutant.replace(old, new, 1)
        try:
            path.write_text(mutant)
            result, count, failed = run(name, specs)
        finally:
            path.write_bytes(original)
        receipt = dict(mutation=name, source=source, baseline_count=baseline[specs], mutant_count=count, failures=failed, restored=path.read_bytes() == original)
        receipts.append(receipt)
        (LOGS / "receipts.json").write_text(json.dumps(receipts, indent=2))
        if result == 0 or count != baseline[specs] or not failed:
            raise RuntimeError(f"Mutation not proved: {receipt}")
        print(json.dumps(receipt), flush=True)
    for specs, expected in baseline.items():
        result, count, _ = run("restored-" + Path(specs[0]).stem, specs)
        if result or count != expected:
            raise RuntimeError(f"Restored suite failed: {specs}, count={count}")
finally:
    for source, original in sources.items():
        (WEB / source).write_bytes(original)
