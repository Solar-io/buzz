#!/usr/bin/env bash
# ============================================================================
# verify-hook-bridge.sh — prove the shared hook policy governs buzz-agent.
#
# This is the W2 exit criterion from docs/plans/BUZZ-MIGRATION-PLAN.md, made
# repeatable. It drives a REAL buzz-agent over ACP with a REAL shell hook and
# asserts on what actually reached the model.
#
# It is a VERIFIER, not a unit test: it needs a compiled buzz-agent and it
# spawns processes. The unit tests live in agent/harness/buzz-hook-bridge.test.ts
# and need none of that.
#
# Requires:
#   BUZZ_SRC=<path to a block/buzz checkout with target/{debug,release}/buzz-agent>
#   bun on PATH
#
# The LLM is a local fake — no provider is contacted, nothing is metered.
# That matters here: the whole point of the migration plan's §0.1 is that we do
# not quietly acquire a metered dependency, and a verifier that needed a real
# model would be exactly that.
#
# Usage: BUZZ_SRC=~/software_development/projects/buzz ./deploy/buzz/verify-hook-bridge.sh
# ============================================================================
set -euo pipefail
KIT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$KIT/../.." && pwd)"
BRIDGE="$REPO/agent/harness/buzz-hook-bridge.ts"

BUZZ_SRC="${BUZZ_SRC:-$HOME/software_development/projects/buzz}"
AGENT=""
for c in "$BUZZ_SRC/target/release/buzz-agent" "$BUZZ_SRC/target/debug/buzz-agent"; do
  [ -x "$c" ] && AGENT="$c" && break
done
[ -n "$AGENT" ] || { echo "FATAL: no buzz-agent binary under $BUZZ_SRC/target — run: cargo build -p buzz-agent" >&2; exit 1; }
command -v bun >/dev/null || { echo "FATAL: bun not on PATH" >&2; exit 1; }

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"; [ -n "${LLM_PID:-}" ] && kill "$LLM_PID" 2>/dev/null || true' EXIT
LLM_PORT="${LLM_PORT:-6199}"
PASS=0; FAIL=0
ok()   { printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL  %s — %s\n' "$1" "$2"; FAIL=$((FAIL+1)); }

# ── fake OpenAI-compatible LLM: always ends the turn, records every request ──
cat > "$WORK/fake-llm.ts" <<'T'
const reqs: unknown[] = [];
const out = process.argv[2]!;
Bun.serve({ port: Number(process.argv[3]), async fetch(req) {
  if (new URL(req.url).pathname.endsWith('/chat/completions')) {
    reqs.push(await req.json());
    await Bun.write(out, JSON.stringify(reqs, null, 2));
    return Response.json({ id:'c', object:'chat.completion', created:1, model:'fake',
      choices:[{index:0,message:{role:'assistant',content:'Done.'},finish_reason:'stop'}],
      usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2} });
  }
  return new Response('{}', { headers:{'content-type':'application/json'} });
}});
T

# ── ACP driver ───────────────────────────────────────────────────────────────
cat > "$WORK/drive.ts" <<'T'
const [agent, work, bridge, settings, manifest, port] = process.argv.slice(2);
const proc = Bun.spawn([agent!], { stdin:'pipe', stdout:'pipe', stderr:'pipe', env:{
  PATH: process.env.PATH!, HOME: process.env.HOME!,
  BUZZ_AGENT_PROVIDER:'openai-compat', OPENAI_COMPAT_API_KEY:'fake',
  OPENAI_COMPAT_MODEL:'fake-model', OPENAI_COMPAT_BASE_URL:`http://127.0.0.1:${port}/v1`,
  MCP_HOOK_SERVERS:'*', BUZZ_AGENT_HOOK_TIMEOUT_MS:'2500', BUZZ_AGENT_STOP_MAX_REJECTIONS:'3',
}});
const send=(o:unknown)=>proc.stdin.write(JSON.stringify(o)+'\n');
const out:any[]=[]; let buf=''; const dec=new TextDecoder();
(async()=>{ for await (const c of proc.stdout){ buf+=dec.decode(c as Uint8Array,{stream:true});
  let i; while((i=buf.indexOf('\n'))>=0){ const l=buf.slice(0,i).trim(); buf=buf.slice(i+1);
    if(l){ try{ out.push(JSON.parse(l)); }catch{} } } } })();
const waitFor=async(p:(o:any)=>boolean,ms=30000)=>{const t=Date.now();
  while(Date.now()-t<ms){const f=out.find(p); if(f)return f; await Bun.sleep(80);} return undefined;};
send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:1,clientCapabilities:{}}});
await waitFor(o=>o.id===1);
const env=[{name:'EVIE_HARNESS_HOOKS',value:'1'},{name:'EVIE_HARNESS_SETTINGS',value:settings!}];
if(manifest) env.push({name:'EVIE_HARNESS_HOOKS_MANIFEST',value:manifest});
send({jsonrpc:'2.0',id:2,method:'session/new',params:{cwd:work,
  mcpServers:[{name:'evie-hooks',command:process.execPath,args:[bridge!,'serve'],env}]}});
const s=await waitFor(o=>o.id===2);
send({jsonrpc:'2.0',id:3,method:'session/prompt',
  params:{sessionId:s?.result?.sessionId,prompt:[{type:'text',text:'say hi'}]}});
await waitFor(o=>o.id===3,45000);
proc.kill();
T

start_llm() { rm -f "$WORK/llm.json"; bun "$WORK/fake-llm.ts" "$WORK/llm.json" "$LLM_PORT" >/dev/null 2>&1 &
              LLM_PID=$!; sleep 2; }
stop_llm()  { kill "$LLM_PID" 2>/dev/null || true; wait "$LLM_PID" 2>/dev/null || true; LLM_PID=""; }
count()     { python3 -c "import json,sys;print(len(json.load(open(sys.argv[1]))))" "$WORK/llm.json" 2>/dev/null || echo 0; }

echo "==> buzz-agent: $AGENT"

# ── CASE 1: a gate hook that objects ────────────────────────────────────────
echo; echo "==> CASE 1 — a gate hook objects, the agent keeps working"
mkdir -p "$WORK/c1"
cat > "$WORK/c1/gate.sh" <<'H'
#!/usr/bin/env bash
cat > /dev/null
echo "REMINDER: tests were never run for this change."
exit 0
H
chmod +x "$WORK/c1/gate.sh"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s"}]}]}}' "$WORK/c1/gate.sh" > "$WORK/c1/settings.json"
start_llm
bun "$WORK/drive.ts" "$AGENT" "$WORK/c1" "$BRIDGE" "$WORK/c1/settings.json" "" "$LLM_PORT" >/dev/null 2>&1 || true
stop_llm
N1=$(count)
if grep -q "tests were never run" "$WORK/llm.json" 2>/dev/null
then ok "the hook's reason reached the model verbatim"
else bad "hook reason reached the model" "not found in the LLM history"; fi
if [ "$N1" -gt 1 ]; then ok "the objection made the agent continue ($N1 LLM round-trips)"
else bad "objection caused a continue" "only $N1 round-trip(s)"; fi
# Count _Stop calls in the FINAL request only. The recorded requests are
# CUMULATIVE — each one carries the whole history — so grepping the file counts
# round 1 three times, round 2 twice, round 3 once: 6 for a budget of 3. That
# arithmetic looks like a broken budget and is really a broken measurement.
#
# `|| true` on every counting pipeline: under `set -o pipefail` a grep that
# matches nothing returns 1 and aborts the verifier mid-run, turning "zero
# objections" into "the script vanished". It did exactly that.
R=$(python3 - "$WORK/llm.json" <<'PYC' || true
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception: print(0); raise SystemExit
last=d[-1] if d else {}
n=sum(1 for m in last.get('messages',[]) for tc in (m.get('tool_calls') or [])
      if tc.get('function',{}).get('name','').endswith('___Stop'))
print(n)
PYC
)
R=${R:-0}
if [ "$R" = "3" ]; then ok "stopped after exactly 3 objections (BUZZ_AGENT_STOP_MAX_REJECTIONS)"
else bad "rejection budget" "saw $R _Stop calls, expected 3"; fi

# ── CASE 2: a finalize-phase hook must NOT run ──────────────────────────────
echo; echo "==> CASE 2 — a finalize-phase hook is denied at the _Stop gate"
mkdir -p "$WORK/c2"
cat > "$WORK/c2/finalize.sh" <<H
#!/usr/bin/env bash
cat > /dev/null
touch "$WORK/c2/RAN"
echo "FINALIZE SPOKE"
exit 0
H
chmod +x "$WORK/c2/finalize.sh"
printf '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"%s"}]}]}}' "$WORK/c2/finalize.sh" > "$WORK/c2/settings.json"
printf '{"deny":{},"stopPhase":{"%s":"finalize"}}' "$WORK/c2/finalize.sh" > "$WORK/c2/manifest.json"
start_llm
bun "$WORK/drive.ts" "$AGENT" "$WORK/c2" "$BRIDGE" "$WORK/c2/settings.json" "$WORK/c2/manifest.json" "$LLM_PORT" >/dev/null 2>&1 || true
stop_llm
N2=$(count)
if [ -f "$WORK/c2/RAN" ]; then bad "finalize hook stayed unrun" "it executed"
else ok "the finalize hook never executed"; fi
if grep -q "FINALIZE SPOKE" "$WORK/llm.json" 2>/dev/null
then bad "finalize text kept out of the model" "it reached the history"
else ok "no finalize text reached the model"; fi
if [ "$N2" = "1" ]; then ok "a clean gate produced no objection (1 LLM round-trip)"
else bad "clean gate" "$N2 round-trips, expected 1"; fi

printf '\n  %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ] || exit 1
