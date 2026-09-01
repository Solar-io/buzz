#!/usr/bin/env bash
# ============================================================================
# mint-agent-key.sh — mint a Nostr identity for ONE agent and register it as a
# relay member.
#
# In Buzz an agent is not a config row, it is a KEYPAIR. Every agent needs its
# own — "Running multiple agents? Mint a separate keypair for each. Every agent
# needs its own identity." (crates/buzz-acp/README.md). Sharing one key across
# seats would collapse the audit trail that is the whole point.
#
# Registration publishes a kind:13534 membership event, which requires the
# relay's own signing key (BUZZ_RELAY_PRIVATE_KEY) — that is why this reads
# the rendered .env rather than taking the key on the command line.
#
# Usage:
#   ./deploy/buzz/agents/mint-agent-key.sh <agent-name> [--register] [--role member|admin] [--dry-run]
#
# Writes:  $BUZZ_RUNTIME_DIR/keys/agents/<agent-name>.{secret,pub}   (0600)
# ============================================================================
set -euo pipefail
. "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"

NAME="${1:-}"; shift || true
[ -n "$NAME" ] || die "usage: mint-agent-key.sh <agent-name> [--register]"
printf '%s' "$NAME" | grep -qE '^[a-z0-9][a-z0-9-]{1,38}$' \
  || die "agent name must be lowercase alphanumeric/dashes, 2-39 chars"

REGISTER=0; ROLE=member
while [ $# -gt 0 ]; do
  case "$1" in
    --register) REGISTER=1; shift ;;
    --role) ROLE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    *) die "unknown flag: $1" ;;
  esac
done
case "$ROLE" in
  member|admin) : ;;
  owner) die "role 'owner' is set only via RELAY_OWNER_PUBKEY in .env, never by add-member" ;;
  *) die "role must be member or admin (got: $ROLE)" ;;
esac

guard_not_under_test

KEYDIR="$BUZZ_RUNTIME_DIR/keys/agents"
SECF="$KEYDIR/$NAME.secret"; PUBF="$KEYDIR/$NAME.pub"

if [ -f "$SECF" ]; then
  # NEVER silently re-mint. A new key is a NEW AGENT to the relay: the old
  # identity keeps its history and memberships, and the new one has none.
  log "agent '$NAME' already has a key: $(cat "$PUBF" 2>/dev/null)"
  log "delete $SECF by hand if you really intend to replace the identity."
else
  run mkdir -p "$KEYDIR"
  if [ "$DRY_RUN" = "1" ]; then
    log "[DRY_RUN] would mint a keypair for '$NAME'"
  else
    read -r SEC PUB < <("$BUZZ_KIT_DIR/lib/nostr-keygen.sh")
    umask 077
    printf '%s\n' "$SEC" > "$SECF"; printf '%s\n' "$PUB" > "$PUBF"
    chmod 600 "$SECF"
    log "minted '$NAME' -> $PUB"
  fi
fi

[ "$REGISTER" = "1" ] || { log "not registering (pass --register to publish membership)"; exit 0; }

step "Registering '$NAME' as a relay member"
ENVF="$BUZZ_CHECKOUT/deploy/compose/.env"
[ -f "$ENVF" ] || die "no $ENVF — run install-buzz-dev.sh first"
PUB="$(cat "$PUBF" 2>/dev/null || echo '<dry-run>')"

# VERIFIED 2026-08-23 against a real relay container: `buzz-admin` ships at
# /usr/local/bin/buzz-admin in ghcr.io/block/buzz, and add-member "publishes a
# kind:13534 membership roster via Redis so live clients see the updated list
# immediately". It needs the container's DB + Redis, so it runs via docker exec
# rather than `docker run` (whose ENTRYPOINT is buzz-relay, not buzz-admin).
#
# Roles are member|admin. It refuses "owner" — the owner is set only by the
# RELAY_OWNER_PUBKEY config value, not by this command.
RELAY_CTR="$(docker ps --format '{{.Names}}' 2>/dev/null | grep -E 'buzz.*relay' | head -1 || true)"
[ -n "$RELAY_CTR" ] || die "no running buzz relay container — start it with deploy-buzz-dev.sh"
run docker exec "$RELAY_CTR" buzz-admin add-member --pubkey "$PUB" --role "$ROLE" \
  || die "add-member failed against $RELAY_CTR"
log "registered $PUB as $ROLE"
[ "$DRY_RUN" = "1" ] || docker exec "$RELAY_CTR" buzz-admin list-members 2>/dev/null | grep -v '"level"' | tail -20 || true
