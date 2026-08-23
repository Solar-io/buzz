#!/usr/bin/env bash
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
workflows=(
  "$root/.github/workflows/ci.yml"
  "$root/.github/workflows/mesh-lifecycle.yml"
  "$root/.github/workflows/release.yml"
)
renovate="$root/renovate.json"
known_good='e18b497796c12c097a38f9edb9d0641fb99eee32'
known_bad='6323deb102c322ba6fcbdcafc7e3dddab59af2b6'

python3 - "$renovate" "$known_good" "$known_bad" "${workflows[@]}" <<'PY'
import json
import pathlib
import re
import sys

renovate_path, known_good, known_bad, *workflow_names = sys.argv[1:]
workflow_paths = [pathlib.Path(path) for path in workflow_names]
workflow = "\n".join(path.read_text() for path in workflow_paths)
ci_workflow = workflow_paths[0].read_text()
renovate = json.loads(pathlib.Path(renovate_path).read_text())

job_match = re.search(r"(?ms)^  unit-tests:\n(.*?)(?=^  [a-z][a-z0-9-]+:\n|\Z)", ci_workflow)
if not job_match:
    raise SystemExit("unit-tests job missing")
job = job_match.group(1)

if f"Swatinem/rust-cache@{known_good} # v2.9.1" not in job:
    raise SystemExit("Unit Tests must pin the last known-good rust-cache v2.9.1 digest")
if "key: sherpa-cache-v1" not in job:
    raise SystemExit("Unit Tests must keep an explicit sherpa cache generation key")
if known_bad in workflow:
    raise SystemExit("a workflow restored the rust-cache v2.9.2 digest that poisons sherpa caches")
uses = re.findall(r"Swatinem/rust-cache@([0-9a-f]{40})", workflow)
if not uses or set(uses) != {known_good}:
    raise SystemExit("CI rust-cache uses must stay on the v2.9.1 digest")

rules = [
    rule
    for rule in renovate.get("packageRules", [])
    if rule.get("matchManagers") == ["github-actions"]
    and rule.get("matchPackageNames") == ["Swatinem/rust-cache"]
]
if len(rules) != 1 or rules[0].get("allowedVersions") != "<=2.9.1":
    raise SystemExit("Renovate must keep Swatinem/rust-cache at v2.9.1 or older")
PY

echo "rust cache contract passed"
