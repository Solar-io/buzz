#!/usr/bin/env bash
# ============================================================================
# verify-interposer.sh — prove the interposer actually STOPS things.
#
# This is the W3 exit criterion from docs/plans/BUZZ-MIGRATION-PLAN.md §5, made
# repeatable. It drives the REAL zero-argument launcher, which spawns the REAL
# `buzz-dev-mcp`, and runs REAL hook scripts through the shared `runHooks()`.
#
# The assertions are deliberately at the FILESYSTEM, not at the reply string:
# a denial that returns the right prose while the command still ran is the exact
# "governed-looking, enforces nothing" failure this whole build exists to avoid.
# So the forbidden shell command writes a sentinel file, and the test is that the
# sentinel is ABSENT.
#
# It is a VERIFIER, not a unit test: it spawns the installed Buzz binary. The
# unit tests are in agent/harness/buzz-mcp-interposer.test.ts and need none of it.
#
# No LLM is contacted and nothing is metered — the interposer is an MCP server,
# so an MCP client is the whole harness.
#
# Usage: ./deploy/buzz/verify-interposer.sh
# Override the child with EVIE_BUZZ_DEV_MCP=… if Buzz.app is elsewhere.
# ============================================================================
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$KIT/../.." && pwd)"
LAUNCHER="$KIT/buzz-mcp-interposer"

export PATH="${PATH}:$HOME/.bun/bin:/opt/homebrew/bin:/usr/local/bin"
command -v bun >/dev/null || { echo "FATAL: bun not on PATH" >&2; exit 1; }
[ -x "$LAUNCHER" ] || { echo "FATAL: $LAUNCHER is not executable" >&2; exit 1; }

CHILD="${EVIE_BUZZ_DEV_MCP:-/Applications/Buzz.app/Contents/MacOS/buzz-dev-mcp}"
[ -x "$CHILD" ] || { echo "FATAL: no buzz-dev-mcp at $CHILD (set EVIE_BUZZ_DEV_MCP)" >&2; exit 1; }

# ⚠️ REALPATH, not the raw `mktemp -d`. On macOS `mktemp -d` hands back
# `/var/folders/…` while `/var` is a symlink to `/private/var`, and `process.cwd()`
# returns the RESOLVED form. The hook below matches an absolute prefix with no
# normalization (deliberately — see its comment), so an unresolved $WORK makes the
# declared-`workdir` case and the server-cwd case produce two DIFFERENT prefixes,
# and the second silently stops matching. That reads exactly like a bypass and is
# not one; pin the realpath once, here, and both cases agree.
WORK="$(cd "$(mktemp -d)" && pwd -P)"; trap 'rm -rf "$WORK"' EXIT

# ── a REAL hook script, in the on-disk shape, reading Claude's ARG names ─────
cat > "$WORK/deny.sh" <<'HOOK'
#!/usr/bin/env bash
payload=$(cat)
case "$payload" in
  *'"command":"'*FORBIDDEN*)
    printf '%s' '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"W3-VERIFY: that command is refused by policy"}}'
    exit 0;;
esac
# ⚠️ ABSOLUTE-PREFIX match with NO normalization — deliberately modelled on
# `pre-protect-governance.sh`, which behaves exactly this way. A relative
# `file_path` sails straight past it, which is what made the omitted-`workdir`
# bypass real. Do not "improve" this into normalizing; the whole point is that
# the interposer must hand the hook an absolute path in the first place.
case "$payload" in
  *'"file_path":"'"$W3_FROZEN_PREFIX"'/frozen-tree/'*)
    printf '%s' '{"decision":"block","reason":"W3-VERIFY: the frozen tree is read only"}'
    exit 0;;
esac
exit 0
HOOK
chmod 755 "$WORK/deny.sh"

cat > "$WORK/stop.sh" <<'HOOK'
#!/usr/bin/env bash
cat > /dev/null
printf '%s\n' 'W3-VERIFY: the stop gate objects'
HOOK
chmod 755 "$WORK/stop.sh"

cat > "$WORK/settings.json" <<JSON
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash|Edit|Write", "hooks": [{ "type": "command", "command": "$WORK/deny.sh" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "$WORK/stop.sh" }] }
    ]
  }
}
JSON

echo '{"deny":{},"stopPhase":{}}' > "$WORK/manifest.json"
mkdir -p "$WORK/frozen-tree"
printf 'original\n' > "$WORK/frozen-tree/file.txt"
# The second file is edited via a RELATIVE path with NO `workdir` — the shape
# that bypassed the guard until the interposer set its own `projectCtx`.
printf 'original\n' > "$WORK/frozen-tree/relative.txt"

# ── the MCP client ───────────────────────────────────────────────────────────
cat > "$WORK/drive.ts" <<'DRIVER'
const [launcher, work, repo, settings, manifest, hooksFlag] = process.argv.slice(2);

const proc = Bun.spawn([launcher!], {
  stdin: 'pipe', stdout: 'pipe', stderr: 'inherit', cwd: work!,
  env: {
    PATH: process.env.PATH!, HOME: process.env.HOME!,
    EVIE_REPO: repo!,
    EVIE_HARNESS_HOOKS: hooksFlag!,
    EVIE_HARNESS_SETTINGS: settings!,
    EVIE_HARNESS_HOOKS_MANIFEST: manifest!,
    // Read by deny.sh, so its absolute-prefix pattern can name this temp dir.
    W3_FROZEN_PREFIX: work!,
    ...(process.env.EVIE_BUZZ_DEV_MCP ? { EVIE_BUZZ_DEV_MCP: process.env.EVIE_BUZZ_DEV_MCP } : {}),
  },
});

const pending = new Map<number, (m: any) => void>();
let buf = ''; const dec = new TextDecoder();
void (async () => {
  const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const m = JSON.parse(line);
      pending.get(m.id)?.(m); pending.delete(m.id);
    }
  }
})();

let nextId = 1;
const send = (o: unknown) => { proc.stdin.write(JSON.stringify(o) + '\n'); proc.stdin.flush(); };
const rpc = (method: string, params: unknown) =>
  new Promise<any>((resolve, reject) => {
    const id = nextId++;
    pending.set(id, resolve);
    setTimeout(() => reject(new Error(`timeout on ${method}`)), 30_000);
    send({ jsonrpc: '2.0', id, method, params });
  });

const init = await rpc('initialize', {
  protocolVersion: '2025-06-18', capabilities: {},
  clientInfo: { name: 'verify-interposer', version: '1' },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });

const list = await rpc('tools/list', {});
const call = (name: string, args: Record<string, unknown>) =>
  rpc('tools/call', { name, arguments: args });

const out: Record<string, unknown> = { init: init.result, tools: list.result?.tools };

out['forbidden'] = (await call('shell', {
  command: `echo FORBIDDEN > ${work}/sentinel.txt`, workdir: work,
})).result;
out['allowed'] = (await call('shell', { command: `echo ok > ${work}/ok.txt`, workdir: work })).result;
out['frozen'] = (await call('str_replace', {
  path: 'frozen-tree/file.txt', old_str: 'original', new_str: 'tampered', workdir: work,
})).result;
// THE BYPASS CASE: a relative path and NO `workdir`. The child resolves it
// against its own cwd (= work) and would edit the file; the hook only matches an
// absolute prefix, so unless the interposer absolutizes, nothing stops it.
out['frozenRelative'] = (await call('str_replace', {
  path: 'frozen-tree/relative.txt', old_str: 'original', new_str: 'tampered',
})).result;
out['todo'] = (await call('todo', {
  todos: [{ text: 'W3-VERIFY todo still visible', done: false }],
})).result;
out['stop'] = (await call('_Stop', {})).result;

await Bun.write(work + '/result.json', JSON.stringify(out, null, 2));
proc.kill();
DRIVER

PASS=0; FAIL=0
ok()  { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad() { printf '  FAIL  %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }
have() { grep -q -- "$1" "$WORK/result.json"; }

echo "== interposer, hooks ON =="
bun "$WORK/drive.ts" "$LAUNCHER" "$WORK" "$REPO" "$WORK/settings.json" "$WORK/manifest.json" 1 \
  || { echo "FATAL: driver failed" >&2; exit 1; }

# 1 — the child's tools survived
MISSING=""
for t in shell read_file str_replace view_image todo _Stop _PostCompact; do
  python3 - "$WORK/result.json" "$t" <<'PY' || MISSING="$MISSING $t"
import json,sys
d=json.load(open(sys.argv[1]))
sys.exit(0 if any(x.get("name")==sys.argv[2] for x in d["tools"]) else 1)
PY
done
[ -z "$MISSING" ] && ok "tools/list forwards every child tool" \
                  || bad "tools/list forwards every child tool" "missing:$MISSING"

# 2 — THE ONE THAT MATTERS: the denied command did not run
[ ! -f "$WORK/sentinel.txt" ] && ok "a denied shell command NEVER RAN (no sentinel on disk)" \
                              || bad "a denied shell command NEVER RAN" "sentinel.txt exists"

# 3 — and the agent was told why
have "EVIE POLICY DENY" && have "W3-VERIFY: that command is refused by policy" \
  && ok "the denial reaches the agent with the hook's own reason" \
  || bad "the denial reaches the agent with the hook's own reason" "marker or reason missing"

# 4 — an ordinary command still works (the discriminator for #2)
[ -f "$WORK/ok.txt" ] && ok "an allowed shell command DID run" \
                      || bad "an allowed shell command DID run" "ok.txt missing"

# 5 — a denied edit left the file untouched
grep -qx 'original' "$WORK/frozen-tree/file.txt" \
  && ok "a denied str_replace left the file unmodified" \
  || bad "a denied str_replace left the file unmodified" "file was rewritten"

# 6 — the bypass: relative path, NO workdir, hook matches only absolute prefixes
grep -qx 'original' "$WORK/frozen-tree/relative.txt" \
  && ok "a relative path with NO workdir is still denied (file unmodified)" \
  || bad "a relative path with NO workdir is still denied" "file was rewritten — the guard was bypassed"

# 7 — _Stop carries OUR objection AND the child's todo output
have "W3-VERIFY: the stop gate objects" \
  && ok "_Stop carries the shared hook's objection" \
  || bad "_Stop carries the shared hook's objection" "hook text missing"
have "W3-VERIFY todo still visible" \
  && ok "_Stop still surfaces the child's open todos" \
  || bad "_Stop still surfaces the child's open todos" "child todo text lost"

# 8 — the flag is what governs. With hooks OFF the SAME command must run.
echo "== interposer, hooks OFF (EVIE_HARNESS_HOOKS=0) =="
rm -f "$WORK/result.json" "$WORK/ok.txt"
bun "$WORK/drive.ts" "$LAUNCHER" "$WORK" "$REPO" "$WORK/settings.json" "$WORK/manifest.json" 0 \
  || { echo "FATAL: driver failed (hooks off)" >&2; exit 1; }
[ -f "$WORK/sentinel.txt" ] \
  && ok "with hooks OFF the same command runs — the deny above came from the HOOK" \
  || bad "with hooks OFF the same command runs" "sentinel still absent; the deny may be unconditional"

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
