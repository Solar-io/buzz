#!/usr/bin/env bash
CAP_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CAP_COMMON_LIB="${DEPLOY_COMMON_LIB:-/Users/sgallant/software_development/projects/shared-infra/lib/deploy-common.sh}"
[[ -r "$CAP_COMMON_LIB" ]] || { printf 'Missing deploy-common library: %s\n' "$CAP_COMMON_LIB" >&2; exit 1; }
# shellcheck source=/dev/null
source "$CAP_COMMON_LIB"
export DC_LOG_FILE="${CAP_DEPLOY_LOG:-$CAP_REPO_ROOT/logs/verification.log}"
CAP_CONFIG="$CAP_REPO_ROOT/deploy/capacitor-config.mjs"
CAP_REGISTRY="${PORT_REGISTRY:-/Users/sgallant/software_development/infra/port-registry.json}"
CAP_STATE_ROOT="${CAP_DEPLOY_STATE_ROOT:-${HOME}/.evie/buzz/deployments}"
umask 077
cap::host_check() {
  local host
  host="$(hostname -s)"; host="${host%.local}"
  [[ "$host" == "${CAP_DEPLOY_EXPECTED_HOST:-crichton}" ]] || dc::die "This workflow targets crichton; current host is $host."
}
cap::port() {
  local port
  port="$(jq -er --arg key "$1" '.project_port_blocks.buzz[$key] | select(type=="number" and .>=1 and .<=65535)' "$CAP_REGISTRY")" || dc::die "Missing port-registry assignment: buzz.$1"
  printf '%s' "$port"
}
cap::id() { docker inspect --format '{{.Id}}' "$1"; }
cap::name() { [[ "$1" =~ ^[A-Za-z0-9][A-Za-z0-9_.-]+$ ]] || dc::die "Invalid Docker container name."; }
cap::new_state() { mkdir -p "$CAP_STATE_ROOT"; chmod 700 "$CAP_STATE_ROOT"; mktemp -d "$CAP_STATE_ROOT/capacitor.XXXXXX"; }
cap::snapshot() {
  local container="$1" directory="$2" prefix="$3"
  docker inspect "$container" > "$directory/$prefix.private.json"
  chmod 600 "$directory/$prefix.private.json"
  jq '.[0] | {Id,Name,Image,State:{Running:.State.Running},Mounts,HostConfig:{NetworkMode:.HostConfig.NetworkMode,PortBindings:.HostConfig.PortBindings,RestartPolicy:.HostConfig.RestartPolicy},Labels:.Config.Labels}' "$directory/$prefix.private.json" > "$directory/$prefix.summary.json"
}
cap::verify_backup() {
  local manifest="$1"; shift
  [[ -r "$manifest" ]] || dc::die "Readable verified backup manifest required."
  node "$CAP_CONFIG" verify-backup "$manifest" "$@" || dc::die "Backup verification failed; no cutover performed."
}
cap::gateway_health() { dc::health_check "http://127.0.0.1:$1/_readiness" --retries "${CAP_HEALTH_RETRIES:-20}" --delay "${CAP_HEALTH_DELAY:-2}"; }
cap::relay_health() { dc::health_check "http://127.0.0.1:$1/_readiness" --retries "${CAP_HEALTH_RETRIES:-20}" --delay "${CAP_HEALTH_DELAY:-2}"; }
