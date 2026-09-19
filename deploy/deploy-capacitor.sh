#!/usr/bin/env bash
# Gateway then relay, with bounded service scope and automatic application rollback.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/capacitor-common.sh"

cap::compose() {
  local state="$1" mode="$2"; shift 2
  local project work_dir env_file context file
  project="$(jq -er .project "$state/relay-state.json")"
  work_dir="$(jq -er .workDir "$state/relay-state.json")"
  env_file="$(jq -er .envFile "$state/relay-state.json")"
  context="$(jq -er .context "$state/relay-state.json")"
  local -a args=(--context "$context" compose --project-name "$project" --project-directory "$work_dir" --env-file "$env_file")
  if [[ "$mode" == rollback ]]; then
    args+=(-f "$state/compose.rollback.private.json")
  else
    while IFS= read -r file; do args+=(-f "$file"); done < <(jq -r '.files[]' "$state/relay-state.json")
    [[ "$mode" != next ]] || args+=(-f "$state/compose.capacitor.json")
  fi
  # Compose interpolation must read the captured .env, never a caller's stale
  # BUZZ_IMAGE/POSTGRES_PASSWORD/etc. Docker authentication remains file-based.
  env -i PATH="$PATH" HOME="$HOME" DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}" docker "${args[@]}" "$@"
}

cap::rollback_relay() {
  local state="$1" env_file name expected current image
  env_file="$(jq -er .envFile "$state/relay-state.json")"
  name="$(jq -er .name "$state/relay-state.json")"; cap::name "$name"
  expected="$(jq -er .oldId "$state/relay-state.json")"
  current="$(cap::id "$name" 2>/dev/null || true)"
  if [[ -n "$current" && "$current" != "$expected" ]]; then
    image="$(docker inspect --format '{{.Image}}' "$current")"
    [[ "$image" == "$(jq -er .newImageId "$state/relay-state.json")" ]] || dc::die "Relay changed outside this deployment; refusing rollback over it."
  fi
  dc::write_env_file "$env_file" < "$state/relay.env.before"
  chmod 600 "$env_file"
  cap::compose "$state" rollback up -d --no-deps --pull never relay > "$state/relay-rollback.private.log" 2>&1 || dc::die "Relay rollback failed; see private state $state."
  cap::relay_health "$(jq -er .healthPort "$state/relay-state.json")" || dc::die "Prior relay restored but health failed."
  dc::ok "Restored prior relay image/configuration; database volumes untouched."
}

cap::cutover_failure() {
  local code=$?
  trap - EXIT
  [[ "${CAP_RELAY_CHANGED:-0}" != 1 ]] || cap::rollback_relay "$CAP_CUTOVER_STATE"
  if [[ "${CAP_GATEWAY_READY:-0}" == 1 ]]; then
    bash "$CAP_REPO_ROOT/deploy/push-gateway-up.sh" --rollback "$CAP_CUTOVER_STATE/gateway" --execute
  fi
  exit "$code"
}

cap::main() {
  local execute=0 replace=0 gateway_image="" relay_image="" manifest="" delivery="" migration_env="" rollback=""
  local relay="${RELAY_CONTAINER:-buzz-dev-relay-1}" gateway="${GATEWAY_CONTAINER:-buzz-push-gateway}"
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --replace-native) replace=1; shift ;;
      --execute) execute=1; shift ;;
      --dry-run) execute=0; shift ;;
      --gateway-image) gateway_image="$2"; shift 2 ;;
      --relay-image) relay_image="$2"; shift 2 ;;
      --backup-manifest) manifest="$2"; shift 2 ;;
      --delivery-url) delivery="$2"; shift 2 ;;
      --gateway-migration-env-file) migration_env="$2"; shift 2 ;;
      --rollback) rollback="$2"; shift 2 ;;
      --help|-h) printf '%s\n' 'Usage: deploy-capacitor.sh --replace-native --gateway-image IMAGE --relay-image IMAGE --backup-manifest FILE [--delivery-url URL] [--gateway-migration-env-file ADMIN_ENV] [--execute|--dry-run]' 'Rollback: deploy-capacitor.sh --rollback STATE_DIR --execute'; return ;;
      *) dc::die "Unknown cutover argument: $1" ;;
    esac
  done
  cap::host_check; cap::name "$relay"; cap::name "$gateway"
  if [[ -n "$rollback" ]]; then
    [[ -r "$rollback/relay-state.json" ]] || dc::die "Cutover state missing."
    if [[ "$execute" == 0 ]]; then dc::info "DRY RUN: restore relay then gateway from $rollback"; return; fi
    cap::rollback_relay "$rollback"
    bash "$CAP_REPO_ROOT/deploy/push-gateway-up.sh" --rollback "$rollback/gateway" --execute
    return
  fi
  [[ "$replace" == 1 && -n "$gateway_image" && -n "$relay_image" ]] || dc::die "Replacement mode and both explicit image references required."
  local old_id gateway_id project work_dir env_file files_csv context health_port file
  old_id="$(cap::id "$relay")"; gateway_id="$(cap::id "$gateway")"
  project="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$old_id")"
  work_dir="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}}' "$old_id")"
  env_file="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.environment_file"}}' "$old_id")"
  files_csv="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$old_id")"
  context="$(docker context show)"; health_port="$(cap::port primary)"
  [[ -n "$project" && -d "$work_dir" && -r "$env_file" && -n "$files_csv" ]] || dc::die "Current Compose metadata is incomplete."
  local -a files
  IFS=',' read -r -a files <<< "$files_csv"
  for file in "${files[@]}"; do [[ -r "$file" ]] || dc::die "Current Compose file unavailable: $file"; done
  if [[ -z "$delivery" ]]; then
    delivery="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$old_id" | awk 'index($0,"BUZZ_PUSH_GATEWAY_DELIVERY_URL=")==1 {sub(/^BUZZ_PUSH_GATEWAY_DELIVERY_URL=/,""); print}')"
  fi
  [[ -n "$delivery" ]] || dc::die "Private gateway delivery URL is not configured; pass --delivery-url."
  node "$CAP_CONFIG" delivery-url "$delivery" >/dev/null
  if [[ "$execute" == 0 ]]; then
    dc::info "DRY RUN: Compose project=$project service=relay; preserve ${#files[@]} current config files and existing web mount."
    dc::info "DRY RUN: gateway=$gateway_image then relay=$relay_image; pairing, agents and database services excluded."
    bash "$CAP_REPO_ROOT/deploy/push-gateway-up.sh" --replace-native --image "$gateway_image" --delivery-url "$delivery" --dry-run
    return
  fi
  cap::verify_backup "$manifest" "gateway=$gateway_id" "relay=$old_id"
  dc::preflight_checkout "$CAP_REPO_ROOT"
  local state new_image_id old_image_id
  new_image_id="$(docker image inspect --format '{{.Id}}' "$relay_image")"
  docker image inspect "$gateway_image" >/dev/null
  state="$(cap::new_state)"
  cap::snapshot "$old_id" "$state" relay
  old_image_id="$(jq -er '.[0].Image' "$state/relay.private.json")"
  cp -p "$env_file" "$state/relay.env.before"; chmod 600 "$state/relay.env.before"
  local i=0
  for file in "${files[@]}"; do cp -p "$file" "$state/compose-source-$i.private"; i=$((i+1)); done
  jq -n --arg name "$relay" --arg oldId "$old_id" --arg newImageId "$new_image_id" --arg project "$project" --arg workDir "$work_dir" --arg envFile "$env_file" --arg context "$context" --arg files "$files_csv" --argjson healthPort "$health_port" \
    '{name:$name,oldId:$oldId,newImageId:$newImageId,project:$project,workDir:$workDir,envFile:$envFile,context:$context,files:($files|split(",")),healthPort:$healthPort}' > "$state/relay-state.json"
  cap::compose "$state" before config --format json > "$state/compose.before.private.json" 2> "$state/compose-check.private.log"
  jq --arg image "$old_image_id" '.services.relay.image=$image' "$state/compose.before.private.json" > "$state/compose.rollback.private.json"
  jq -n --arg image "$new_image_id" --arg delivery "$delivery" '{services:{relay:{image:$image,environment:{BUZZ_PUSH_CAPACITOR_ENABLED:"true",BUZZ_PUSH_GATEWAY_DELIVERY_URL:$delivery}}}}' > "$state/compose.capacitor.json"
  cap::compose "$state" next config --format json > "$state/compose.next.private.json" 2>> "$state/compose-check.private.log"
  node "$CAP_CONFIG" check-compose "$state/compose.before.private.json" "$state/compose.next.private.json"
  node "$CAP_CONFIG" relay-env "$state/relay.env.before" "$delivery" | dc::write_env_file "$state/relay.env.next"
  CAP_CUTOVER_STATE="$state"; CAP_GATEWAY_READY=0; CAP_RELAY_CHANGED=0
  trap cap::cutover_failure EXIT
  trap 'exit 130' HUP INT TERM
  local -a gateway_args=(--replace-native --image "$gateway_image" --delivery-url "$delivery" --topic cloud.noet.buzz --backup-manifest "$manifest" --state-dir "$state/gateway" --execute)
  [[ -z "$migration_env" ]] || gateway_args+=(--migration-env-file "$migration_env")
  bash "$CAP_REPO_ROOT/deploy/push-gateway-up.sh" "${gateway_args[@]}"
  CAP_GATEWAY_READY=1
  [[ "$(cap::id "$relay")" == "$old_id" ]] || dc::die "Relay changed during gateway cutover; rolling gateway back."
  CAP_RELAY_CHANGED=1
  dc::write_env_file "$env_file" < "$state/relay.env.next"; chmod 600 "$env_file"
  cap::compose "$state" next up -d --no-deps --pull never relay > "$state/relay-start.private.log" 2>&1
  cap::relay_health "$health_port" || dc::die "Relay health failed; automatic rollback follows."
  trap - EXIT HUP INT TERM
  dc::ok "Gateway and relay ready. Prior gateway container and relay config retained at $state."
}
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then cap::main "$@"; fi
