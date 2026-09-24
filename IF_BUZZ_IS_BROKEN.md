# IF BUZZ IS BROKEN — break-glass runbook for a plain Claude Code session

**Who this is for:** a Claude Code session started **outside Buzz** (Terminal on crichton, or `ssh crichton` from aeryn) when Buzz itself is down. In that state the Buzz agents can't help, because they live inside it. You have no `buzz` CLI context, no channel and no teammates. That's fine: everything below uses only the shell.

**Host:** crichton (macOS). Everything Buzz runs here. Docker is **Docker Desktop**.
**Rules:** look before you change anything. Take a DB backup before any Postgres or volume operation. **Never** run `docker compose down -v`, delete volumes, or `docker rm` a postgres/minio container. Tell Sam what you ran and what it printed.

Written 2026-09-24. Every command below was run on that date and returned the result shown. If a name or port no longer matches, trust `docker ps` and the files named here over this page.

---

## 1. What Buzz is made of

| Piece | What it is | How it runs | Where |
|---|---|---|---|
| **Relay** | The server: all messages, channels, auth | Docker compose project **`buzz-dev`**, container `buzz-dev-relay-1`, `127.0.0.1:6350` | Compose files: `deploy/compose/` + `deploy/dev-kit/` in this repo |
| **Relay data** | Postgres / Redis / MinIO (media) | `buzz-dev-postgres-1`, `buzz-dev-redis-1`, `buzz-dev-minio-1` (same compose project) | Docker volumes |
| Pairing sidecar | Device pairing | `buzz-dev-pairing-relay-1`, `:6358` | same project |
| Push gateway | Mobile push | `buzz-push-gateway`, `:6359` | `deploy/compose/compose.push-gateway.yml` |
| **Front door** | Tailnet HTTPS | `tailscale serve`: `https://crichton.tailb3d4b8.ts.net:6351` → `:6350` | |
| **Relay supervisor** | Starts the stack at login | launchd `com.dev.buzz-relay` → `~/.config/dev-services/buzz-relay-dev.sh` (the INSTALLED copy; the repo copy is `deploy/dev-kit/launchd/`) | logs: `~/.evie/buzz/buzz-relay-dev.log`, `.err.log` |
| **Agents** | Every AI agent (Opus 1, Gilfoyle, …) | Spawned by the **Buzz desktop app** `/Applications/Buzz.app`. It runs one `target/release/buzz-acp` process per agent, and each of those runs `claude-agent-acp` | Agent config: `~/Library/Application Support/xyz.block.buzz.app/agents/managed-agents.json`; per-agent logs: `…/agents/logs/<agent>__<owner>.log` |
| **buzz-services** | Scheduler: reminders/wakes, the daily edition, alerts, jobs | launchd `com.buzz-services.scheduler`, `.watcher`, `.actions`, `.beat-check` | Repo `~/software_development/projects/buzz-services`; logs in its `logs/` (`scheduler.log`, `watcher.log`) |
| DB backup | Nightly 1:30 AM dump of Postgres + MinIO | launchd `com.dev.backup-buzz-db` | Dumps: `~/.sysmon/db-dumps/buzz/latest/` (`buzz.dump`, `globals.sql.gz`, `minio-data.tar`, `MANIFEST`) |

**Not the live relay; leave these alone:** containers `buzz-prod-*` (a parked prod stack; `buzz-prod-relay-1` sits in "Created" on purpose) and the standalone `buzz-postgres`, `buzz-redis` and `buzz-minio`.

---

## 2. Triage: find the broken layer (read-only, ~1 minute)

```bash
docker info >/dev/null 2>&1 && echo "docker OK" || echo "DOCKER DOWN"
curl -s -m 5 http://127.0.0.1:6350/_liveness; echo          # expect: ok
curl -s -m 5 http://127.0.0.1:6350/_readiness; echo         # expect: {"status":"ready"}
curl -sk -m 5 -o /dev/null -w '%{http_code}\n' https://crichton.tailb3d4b8.ts.net:6351/_liveness   # expect 200
cd ~/software_development/projects/buzz && ./deploy/dev-kit/deploy-buzz-dev.sh --status   # all "Up (healthy)"
./deploy/dev-kit/smoke-buzz-dev.sh                           # expect "13 passed, 0 failed"
pgrep -fl buzz-acp | head; pgrep -f claude-agent-acp | wc -l  # agents alive?
launchctl list | grep -E 'buzz-services|com.dev.buzz'        # 2nd column = last exit code (0 = fine)
```

| Symptom | Layer | Go to |
|---|---|---|
| `DOCKER DOWN` | Docker Desktop | §3.1 |
| `_liveness` fails on :6350 | Relay container | §3.2 |
| :6350 is fine but :6351 fails | Tailscale front door | §3.3 |
| Relay healthy, but agents don't answer | Desktop app / agents | §3.4 |
| Messages fine, but wakes/reminders/edition don't fire | buzz-services | §3.5 |
| Relay up but readiness is not ready, or DB errors in logs | Postgres/Redis | §3.6 |

Logs worth reading first:
```bash
docker logs --tail 100 buzz-dev-relay-1
tail -50 ~/.evie/buzz/buzz-relay-dev.err.log
tail -50 ~/software_development/projects/buzz-services/logs/scheduler.log
ls -t ~/Library/Application\ Support/xyz.block.buzz.app/agents/logs | head   # newest agent logs
```

---

## 3. Fixes, least to most invasive

### 3.1 Docker Desktop down
```bash
open -a Docker        # wait until `docker info` works (up to ~2 min)
launchctl kickstart gui/$(id -u)/com.dev.buzz-relay   # brings the compose stack back up
```

### 3.2 Relay container down or unhealthy
Use the repo's deploy script. Never hand-run `docker run` or `docker compose` with your own file list, because the stack is five compose files layered in a fixed order and the script knows it.
```bash
cd ~/software_development/projects/buzz
./deploy/dev-kit/deploy-buzz-dev.sh --restart-only    # bounce the stack without rebuilding
./deploy/dev-kit/smoke-buzz-dev.sh                    # must be 13/13 before you call it fixed
```
If a *recent image change* broke it, roll back to the previous image. The `.env` backups in `deploy/compose/.env.bak-*` record earlier `BUZZ_IMAGE` values. Read `~/.buzz/GUIDES/RELAY_RECREATE_RULES.md` before recreating (it has a voice-path check). The relay image is `buzz-relay:<git-sha>`; `docker images buzz-relay` lists the ones available locally.

### 3.3 Front door (:6351) down but :6350 up
```bash
tailscale serve status | grep -A2 ':6351'   # expect "/ proxy http://127.0.0.1:6350" and "/pair proxy http://127.0.0.1:6358"
```
Tailscale is the macOS app (`/Applications/Tailscale.app`). If serve is missing, run `./deploy/dev-kit/deploy-buzz-dev.sh` without `--restart-only`: it re-applies the front door. Don't expose anything publicly; access is Tailscale-only by policy.

### 3.4 Agents not answering (relay healthy)
Agents are children of the Buzz desktop app. Restarting the app restarts all of them. Their state lives on disk and in the relay, so nothing is lost.
```bash
osascript -e 'quit app "Buzz"'; sleep 5
pgrep -f buzz-acp && echo "stragglers still running"   # if so: pkill -f 'target/release/buzz-acp'
open -a Buzz
```
Then read the newest agent logs (see §2). Common causes:
- **Claude auth expired:** the log shows 401/auth errors. Sam has to re-login; you can't fix it.
- **Model/provider errors:** agents that route through OmniRoute need it up; see `~/.buzz/GUIDES/BUZZ_AGENT_OMNIROUTE_SETUP.md`.
- **Broken `buzz-acp` binary after a build:** the app runs `~/software_development/projects/buzz/target/release/buzz-acp`. Rebuild it with `cd ~/software_development/projects/buzz && cargo build --release -p buzz-acp`, or check out the last good commit and rebuild.

Don't hand-edit `managed-agents.json` unless you have to. If you do, back it up first; there are earlier copies (`*.bak-*`, `*.restored.json`) beside it.

### 3.5 buzz-services (wakes, reminders, daily edition)
```bash
cd ~/software_development/projects/buzz-services
tail -80 logs/scheduler.log
./deploy-dev.sh          # standard deploy: runs the tests, reinstalls, restarts all four launchd jobs, checks they loaded
```
Reminders live in `services.db` (SQLite, in the repo dir). `bun run src/jobs/cli.ts list` shows job status. It needs Bun's full path: `/Users/sgallant/.bun/bin/bun`.

### 3.6 Database (Postgres/Redis)
```bash
docker logs --tail 100 buzz-dev-postgres-1
docker exec buzz-dev-postgres-1 pg_isready -U buzz
```
- **Before anything invasive, dump first:**
  `docker exec buzz-dev-postgres-1 pg_dump -U buzz -Fc buzz > ~/buzz-emergency-$(date +%Y%m%d-%H%M).dump`
- A full disk is the most common real cause: run `df -h /` and check Docker Desktop's disk usage.
- **Restore** means replacing live data. **Get Sam's explicit OK first.** Use `~/.sysmon/db-dumps/buzz/latest/`: restore `globals.sql.gz` (roles) first, then `buzz.dump` with `pg_restore`. The backup script is `~/software_development/projects/systems_monitoring/backups/backup-buzz-db.sh`, and its header explains the format. Note that `events` is partitioned, so restore the whole dump, not `-t events`.

---

## 4. When it's fixed
1. `./deploy/dev-kit/smoke-buzz-dev.sh` → 13 passed.
2. Check that an agent actually replies: post in Buzz, or look for a fresh line in its log.
3. Write what broke, what you ran and what fixed it to `~/.buzz/WORK_LOGS/<date>_buzz-outage.md`, so the Buzz agents learn about it when they come back.

## 5. Other docs
- This repo's `AGENTS.md`: how to build and test.
- `deploy/dev-kit/README.md`: how the stack was installed (ports, secrets file `~/.evie/buzz/secrets.env`, keys).
- `~/.buzz/GUIDES/`: the agents' own runbooks (relay recreate, web bundle deploy, wakes).
- `~/.claude/agents/INFRASTRUCTURE.md`: hosts and fleet rules.
