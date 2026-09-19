# Native iOS gateway and relay cutover

`deploy-capacitor.sh` is the standard reversible workflow for replacing the
unused Flutter app's gateway profile with the Capacitor app using the existing
`cloud.noet.buzz` identity. It targets **crichton**, uses the shared `dc::`
deployment library, and defaults to a read-only dry run. It does not build
images, obtain Apple credentials, install an iPhone application, deploy web
assets, or alter agents/pairing/database services.

## Prepare

Build and verify the gateway and relay images from the integrated checkout.
The gateway image must include the explicit replacement-mode alias rule:
reusing `cloud.noet.buzz` is allowed only when every enabled profile is a
Capacitor profile. Both images must already exist locally; deployment resolves
their immutable image IDs before cutting over.

Create and verify database backups **before** invoking the workflow. It accepts
a private JSON manifest in this shape (additional fields are retained by the
operator and ignored by the checker):

```json
{
  "version": 1,
  "verified": true,
  "containers": {
    "gateway": "64-character-current-gateway-container-id",
    "relay": "64-character-current-relay-container-id"
  },
  "artifacts": [
    { "path": "/absolute/path/gateway.dump", "sha256": "64-character-hash" },
    { "path": "/absolute/path/relay.dump", "sha256": "64-character-hash" }
  ]
}
```

The script verifies every file is nonempty, hashes match, and named containers
still match the backup. `verified:true` records the operator's separate dump
validation; a matching hash alone is not evidence that a database can restore.

Existing gateway runtime credentials and keyrings are copied from its private
Docker inspection into a mode-0600 env file. They are **not rotated** and are not
printed or passed as command-line values. Existing `/secrets` mount contents are
reused. The script rejects missing/placeholder provider IDs or malformed
keyrings instead of falling back to placeholder credentials. Root/administrator
database credentials never enter the runtime container.

Gateway migrations are opt-in with `--gateway-migration-env-file PATH`. Prepare
that private file through the approved Infisical workflow; it contains
`DATABASE_URL` for the migration role and `BUZZ_PUSH_RUNTIME_DATABASE_ROLE`.
Migrations run before stopping the old gateway, after backup verification. The
existing relay's `BUZZ_AUTO_MIGRATE` setting is preserved; review migration
compatibility for the selected image before execution. Application rollback
does not reverse DDL or restore a database automatically.

## Plan and execute

```sh
bash deploy/deploy-capacitor.sh --replace-native \
  --gateway-image buzz-push-gateway:REVIEWED_SHA \
  --relay-image buzz-relay:REVIEWED_SHA \
  --backup-manifest /absolute/path/backup-manifest.json \
  --dry-run
```

The delivery URL defaults to the currently configured relay's
`BUZZ_PUSH_GATEWAY_DELIVERY_URL`; pass `--delivery-url` to override it deliberately.
It must be the exact private HTTPS `/v1/deliveries/apns` URL. The gateway receives
that same audience with `BUZZ_PUSH_ALLOW_SELF_HOSTED_URL=true` and only
`buzz-capacitor-ios-sandbox,buzz-capacitor-ios-production` profiles. The relay
receives `BUZZ_PUSH_CAPACITOR_ENABLED=true` and the same delivery URL.

After reviewing the dry run and backup, use the same command with `--execute`.
The workflow:

1. Discovers Compose project/files/working directory/env from the active relay's
   Docker labels and reads host ports from `infra/port-registry.json`.
2. Captures private container, database, env, Compose and immutable image state
   under a new mode-0700 `~/.evie/buzz/deployments/capacitor.*` directory.
3. Checks the rendered Compose change: only relay image and the two native push
   environment values may change. Changed web mounts, secrets, ports or any
   other service fail the check.
4. Creates the new gateway container before stopping the old one; renames and
   retains the actual old container stopped; starts and checks the replacement.
5. Atomically persists relay push flags and recreates **only** the relay with
   `compose up --no-deps --pull never relay`, retaining every discovered overlay
   including the web mount and pairing configuration. The image override is a
   durable file within the deployment state directory, recorded in Docker labels.
6. Checks actual readiness endpoints. Failure restores application state
   automatically; private failure logs stay in the state directory.

The script never runs `compose down`, prunes containers/images/volumes, removes
the old gateway, or restarts the pairing relay. The managed relay container can
be recreated by Compose; its **image/configuration**, not its original container
ID, is what rollback preserves. Retain deployment state directories while their
overlays are referenced by the active Docker labels.

## Rollback

The successful command prints its state directory. Restore with:

```sh
bash deploy/deploy-capacitor.sh --rollback /absolute/deployment/state --dry-run
bash deploy/deploy-capacitor.sh --rollback /absolute/deployment/state --execute
```

Relay rollback restores the old env and immutable image using captured resolved
Compose configuration. Gateway rollback checks identities, stops/renames only
the candidate created by that deployment, and restarts the preserved original.
Failed replacement containers are retained for inspection. If another deploy
has changed the target, rollback refuses to overwrite it. Database restoration
is a separate, deliberate operation using the verified backups.

For standalone gateway maintenance, `push-gateway-up.sh` also defaults to dry
run. Without `--replace-native` it retains the existing legacy configuration;
its legacy default image is `buzz-push-gateway:d029`. Execution still requires
an explicit verified backup manifest. Native mode additionally requires an
explicit image and delivery URL.

## Verification and operating limits

```sh
bash -n deploy/capacitor-common.sh deploy/push-gateway-up.sh deploy/deploy-capacitor.sh
node --test deploy/tests/*.test.mjs
shellcheck -x deploy/capacitor-common.sh deploy/push-gateway-up.sh deploy/deploy-capacitor.sh
```

The fixture suite executes the real gateway script against isolated Docker/curl
state-machine doubles. It verifies healthy retention, readiness/start/rename
failure restoration, integrated relay failure restoring both applications,
dry-run read-only behavior, secret-output exclusion,
manifest checksum checks, and unrelated Compose-service protection. Those tests
do not establish a live deployment, real APNs delivery, or database rollback.

Overrides for another explicit installation: `DEPLOY_COMMON_LIB`,
`PORT_REGISTRY`, `CAP_DEPLOY_STATE_ROOT`, `CAP_DEPLOY_LOG`, `RELAY_CONTAINER`,
`GATEWAY_CONTAINER`, and `GATEWAY_DB_CONTAINER`. Host changes require the explicit
`CAP_DEPLOY_EXPECTED_HOST` override; the current fleet target is crichton.
