#!/usr/bin/env bash
# Existing gateway replacement; default is read-only planning, never recreation.
set -euo pipefail
# shellcheck source=deploy/capacitor-common.sh
source "$(dirname "${BASH_SOURCE[0]}")/capacitor-common.sh"

gateway::rollback() {
  local state="$1" name previous previous_id current expected failed port
  [[ -r "$state/gateway-state.json" ]] || dc::die "Gateway rollback state missing."
  name="$(jq -er .name "$state/gateway-state.json")"; cap::name "$name"
  previous="$(jq -er .previous "$state/gateway-state.json")"; cap::name "$previous"
  previous_id="$(jq -er .previousId "$state/gateway-state.json")"
  [[ "$(cap::id "$previous")" == "$previous_id" ]] || dc::die "Gateway rollback identity mismatch."
  expected="$(jq -r '.newId // empty' "$state/gateway-state.json")"
  current="$(cap::id "$name" 2>/dev/null || true)"
  if [[ -n "$current" ]]; then
    [[ -n "$expected" && "$current" == "$expected" ]] || dc::die "Refusing to stop a gateway not created by this deployment."
    docker stop --time 20 "$name" >/dev/null
    failed="$name.failed.$(date +%Y%m%d%H%M%S).$$"
    docker rename "$name" "$failed"
  fi
  docker rename "$previous" "$name"
  if [[ "$(jq -r .wasRunning "$state/gateway-state.json")" == true ]]; then
    docker start "$name" >/dev/null
    port="$(jq -er .healthPort "$state/gateway-state.json")"
    cap::gateway_health "$port" || dc::die "Prior gateway restored but readiness failed."
  fi
  dc::ok "Restored prior gateway container $previous_id; failed replacement retained if present."
}

gateway::failure() {
  local code=$?
  trap - EXIT
  if [[ "${CAP_GATEWAY_MOVED:-0}" == 1 ]]; then
    gateway::rollback "$CAP_GATEWAY_STATE" || dc::err "Automatic gateway rollback failed; inspect private state $CAP_GATEWAY_STATE."
  elif [[ "${CAP_GATEWAY_STOPPED:-0}" == 1 && "${CAP_GATEWAY_WAS_RUNNING:-false}" == true ]]; then
    docker start "$CAP_GATEWAY_OLD_ID" >/dev/null || dc::err "Could not restart the previous gateway."
  fi
  exit "$code"
}

gateway::main() {
  local mode=legacy execute=0 rollback="" image="${IMAGE:-}" manifest="" delivery="" topic="${CAPACITOR_APNS_TOPIC:-cloud.noet.buzz}"
  local name="${GATEWAY_CONTAINER:-buzz-push-gateway}" state="" migrate_env=""
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --replace-native) mode=native; shift ;;
      --execute) execute=1; shift ;;
      --dry-run) execute=0; shift ;;
      --image) image="$2"; shift 2 ;;
      --backup-manifest) manifest="$2"; shift 2 ;;
      --delivery-url) delivery="$2"; shift 2 ;;
      --topic) topic="$2"; shift 2 ;;
      --state-dir) state="$2"; shift 2 ;;
      --migration-env-file) migrate_env="$2"; shift 2 ;;
      --rollback) rollback="$2"; shift 2 ;;
      --help|-h) printf '%s\n' 'Usage: push-gateway-up.sh [--replace-native --image IMAGE --delivery-url URL] [--backup-manifest FILE] [--migration-env-file ADMIN_ENV] [--execute|--dry-run]' 'Rollback: push-gateway-up.sh --rollback STATE_DIR --execute'; return ;;
      *) dc::die "Unknown gateway deployment argument: $1" ;;
    esac
  done
  cap::host_check; cap::name "$name"
  if [[ -n "$rollback" ]]; then
    if [[ "$execute" == 0 ]]; then dc::info "DRY RUN: restore gateway from $rollback"; return; fi
    gateway::rollback "$rollback"; return
  fi
  local old_id network staging api_port health_port
  old_id="$(cap::id "$name")" || dc::die "Existing gateway required; this workflow never invents provider credentials."
  network="$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$old_id")"
  staging="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/secrets"}}{{.Source}}{{end}}{{end}}' "$old_id")"
  [[ -n "$network" && -n "$staging" ]] || dc::die "Gateway network or /secrets mount unresolved."
  api_port="$(cap::port push_gateway)"; health_port="$(cap::port push_gateway_metrics)"
  if [[ "$mode" == native ]]; then
    [[ -n "$image" && -n "$delivery" ]] || dc::die "Native replacement requires explicit --image and --delivery-url."
    node "$CAP_CONFIG" delivery-url "$delivery" >/dev/null
  else image="${image:-buzz-push-gateway:d029}"; fi
  if [[ "$execute" == 0 ]]; then
    dc::info "DRY RUN: gateway mode=$mode image=$image network=$network; loopback ports $api_port/$health_port; retain $old_id for rollback."
    [[ -z "$migrate_env" ]] || dc::info "DRY RUN: explicit migration requested; verified backup required."
    return
  fi
  cap::verify_backup "$manifest" "gateway=$old_id"
  local image_id
  image_id="$(docker image inspect --format '{{.Id}}' "$image")" || dc::die "Build/load the requested gateway image first."
  [[ -r "$staging/key.p8" && -r "$staging/AppleAppAttestRootCA.pem" ]] || dc::die "Existing provider key/certificate mount incomplete."
  dc::preflight_checkout "$CAP_REPO_ROOT"
  if [[ -n "$state" ]]; then [[ ! -e "$state" ]] || dc::die "State directory exists."; mkdir -p "$state"; else state="$(cap::new_state)"; fi
  chmod 700 "$state"
  cap::snapshot "$old_id" "$state" gateway
  cap::snapshot "${GATEWAY_DB_CONTAINER:-buzz-dev-postgres-1}" "$state" database
  node "$CAP_CONFIG" gateway-env "$state/gateway.private.json" "$mode" "$delivery" "$topic" | dc::write_env_file "$state/gateway.env"
  chmod 600 "$state/gateway.env"
  if [[ -n "$migrate_env" ]]; then
    [[ -r "$migrate_env" && -s "$migrate_env" ]] || dc::die "Migration env unreadable or empty."
    docker run --rm --network "$network" --env-file "$migrate_env" "$image_id" --migrate-only > "$state/migration.private.log" 2>&1 || dc::die "Migration failed; old gateway not stopped. See private state log."
  fi
  local stamp previous candidate new_id was_running
  stamp="$(date +%Y%m%d%H%M%S).$$"; previous="$name.previous.$stamp"; candidate="$name.candidate.$stamp"
  was_running="$(jq -r '.[0].State.Running' "$state/gateway.private.json")"
  new_id="$(docker create --name "$candidate" --network "$network" --restart unless-stopped \
    -p "127.0.0.1:$api_port:8080" -p "127.0.0.1:$health_port:8081" \
    --mount "type=bind,source=$staging,target=/secrets,readonly" --env-file "$state/gateway.env" \
    --health-cmd "bash -ec 'exec 3<>/dev/tcp/127.0.0.1/8081; printf \"GET /_readiness HTTP/1.1\\r\\nHost: localhost\\r\\nConnection: close\\r\\n\\r\\n\" >&3; grep -q \"200 OK\" <&3'" \
    --health-interval 10s --health-timeout 5s --health-retries 6 "$image_id")"
  jq -n --arg name "$name" --arg previous "$previous" --arg previousId "$old_id" --arg newId "$new_id" --argjson wasRunning "$was_running" --argjson healthPort "$health_port" \
    '{name:$name,previous:$previous,previousId:$previousId,newId:$newId,wasRunning:$wasRunning,healthPort:$healthPort}' > "$state/gateway-state.json"
  CAP_GATEWAY_STATE="$state"; CAP_GATEWAY_MOVED=0; CAP_GATEWAY_STOPPED=0
  CAP_GATEWAY_OLD_ID="$old_id"; CAP_GATEWAY_WAS_RUNNING="$was_running"
  trap gateway::failure EXIT
  trap 'exit 130' HUP INT TERM
  [[ "$(cap::id "$name")" == "$old_id" ]] || dc::die "Gateway changed during preflight; refusing cutover."
  docker stop --time 20 "$name" >/dev/null; CAP_GATEWAY_STOPPED=1
  docker rename "$name" "$previous"; CAP_GATEWAY_MOVED=1
  docker rename "$candidate" "$name"
  docker start "$name" >/dev/null
  if ! cap::gateway_health "$health_port"; then
    docker logs --tail 100 "$name" > "$state/gateway-start.private.log" 2>&1 || true
    dc::die "New gateway failed readiness; automatic rollback follows."
  fi
  trap - EXIT HUP INT TERM
  dc::ok "Gateway ready; previous container retained. Rollback state: $state"
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then gateway::main "$@"; fi
