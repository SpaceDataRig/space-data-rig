# Space Data Rig on OpenRig

This folder is a self-contained [OpenRig](https://openrig.dev) rig that runs the
Space Data Rig science pipeline as a five-seat agent team, with the deterministic
detection code containerized as managed services.

```
openrig/
  rig.yaml              RigSpec 0.2 -- pod "science", 5 seats, compose services
  CULTURE.md            coordination norms delivered to every seat
  docker-compose.yaml   api (dashboard) + sim-runner (science worker)
  Dockerfile            Node 24 image for both roles (build context = repo root)
  agents/<seat>/        one AgentSpec 1.0 (agent.yaml + guidance/role.md) per seat
```

Seats and sessions:

| Seat | Session address | Runtime | Stage |
|------|-----------------|---------|-------|
| Data Fetch | `science-fetch@space-data-rig` | claude-code | pull NASA/MAST data + provenance hash |
| Anomaly Scout | `science-scout@space-data-rig` | claude-code | BLS transit search + odd-even alias |
| Sim Runner | `science-sim@space-data-rig` | codex | injection-recovery confidence + ephemeris |
| Mission Critic | `science-critic@space-data-rig` | codex | cross-match + verdict |
| Reporter | `science-reporter@space-data-rig` | claude-code | bundle + hash + narration |

## Prerequisites

OpenRig needs **Node.js 22 or 24** and **tmux**, on macOS or Linux. On Windows the
supported route is **WSL2** (native Windows is not supported). Docker is required
for the managed `services` block.

```bash
# inside WSL2 (Ubuntu)
nvm install 24            # or your distro's Node 22/24
npm install -g @openrig/cli
rig setup --dry-run       # preview, then: rig setup
sudo apt-get install -y tmux docker.io
```

Sign in to the provider(s) you use (`claude auth login` and/or `codex login`).
This rig mixes Claude Code and Codex seats; if you only have one provider, either
edit the `runtime:` of the `sim` and `critic` members in `rig.yaml` to match, or
ask the kernel operator to adapt the team for your providers.

## Validate and launch

Run from the **repository root** (the folder containing `package.json`):

```bash
rig spec validate ./openrig/rig.yaml     # schema check (no daemon needed)
rig spec preflight ./openrig/rig.yaml    # resolve agent_refs, runtimes, cwd
rig up ./openrig --cwd .                 # boot services, then the 5 seats
```

`--cwd .` makes every seat's working directory the repo root, so `npm run ...`
commands in the role guidance resolve correctly. OpenRig boots the compose
services first and waits on `http://127.0.0.1:8787/health` before launching agents.

See the team:

```bash
rig terminal open saved:kernel --window   # or: rig tui
rig ps --nodes --rig space-data-rig
```

Give the pipeline a bounded outcome (the lead seat delegates down the chain):

```bash
rig send science-fetch@space-data-rig \
  "Run 'npm run orchestrator -- --targets 6' and hand each target down the pipeline. Report each finding's verdict, score and bundle hash."
```

## Snapshot / restore

Long multi-sector runs checkpoint automatically (`out/state/rig.json`). To stop
and later resume exactly where the rig left off:

```bash
rig down --snapshot space-data-rig
rig up ./openrig --cwd .          # restores from the latest snapshot
```

The application layer has its own resume too:

```bash
npm run orchestrator -- --resume  # skips targets already done in the snapshot
```

## Services only (no agents)

You can run the containerized pipeline + dashboard without OpenRig:

```bash
docker compose -f openrig/docker-compose.yaml up --build
# dashboard: http://localhost:8787   live events: http://localhost:8787/api/events
```

Or natively (no Docker):

```bash
npm install
npm run orchestrator -- --targets 6   # science worker
npm run api                           # dashboard + SSE
npm run anchor                        # anchor accepted bundles on Solana mainnet
```

## Sharing as a bundle

```bash
rig bundle check ./openrig
rig bundle create ./openrig --out space-data-rig.rigbundle
```

The bundle vendors these AgentSpecs and adds SHA-256 integrity, matching the
per-finding bundles the Reporter writes under `out/bundles/`.
