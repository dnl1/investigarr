# Investigarr

Real-time log viewer with automated diagnostics and fixes for the \*arr media stack.

A single-page web app that streams Docker container logs over SSE, detects common issues, and provides one-click fixes — no configuration required beyond the services you want to monitor.

![screenshot](https://img.shields.io/badge/stack-React%20%2B%20Fastify%20%2B%20SSE-blue)

## Features

- **Live log tail** — SSE stream from Docker containers with pause, resume, and auto-scroll
- **Smart filtering** — toggle services and log levels; full-text search across all messages
- **Stack trace grouping** — continuations are merged so multi-line errors stay readable
- **Suggestions** — real-time analysis of recent logs flags actionable problems (connection refused, stalled downloads, missing files, etc.)
- **Runbook** — 11 common troubleshooting entries with symptoms, causes, and step-by-step commands
- **Resolvers** — 5 automated fix sequences (restart services, reannounce torrents, force searches, refresh libraries) executed via Docker or service APIs
- **Multi-select resolve** — check multiple fixes and run them in sequence
- **Settings panel** — configure API keys and custom service URLs; persists across restarts
- **Export** — download the visible log stream as a timestamped text file
- **Dark theme** — flat palette, variable-based, readable on any display

## Supported Services

| Service | Default URL | Port |
|---------|-------------|------|
| Sonarr | `http://sonarr:8989` | 8989 |
| Radarr | `http://radarr:7878` | 7878 |
| Prowlarr | `http://prowlarr:9696` | 9696 |
| Lidarr | `http://lidarr:8686` | 8686 |
| Readarr | `http://readarr:8787` | 8787 |
| Mylar3 | `http://mylar3:8090` | 8090 |
| Jellyseerr | `http://jellyseerr:5055` | 5055 |
| qBittorrent | `http://qbittorrent:8081` | 8081 |
| Jellyfin | `http://jellyfin:8096` | 8096 |

All URLs are auto-detected when running inside Docker. Override them in the **⚙ Settings** drawer for non-Docker setups or custom hosts.

## Quick Start

```bash
git clone https://github.com/dnl1/homelab.git
cd docker/media/investigarr
cp .env.example .env
# Edit .env with your SERVICES list if needed
docker compose up -d --build
```

Open `http://localhost:8788`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8788` | HTTP server port |
| `LOG_TAIL` | `250` | Initial log lines per container |
| `LOG_SINCE` | `2h` | Read logs since (`2h`, `30m`, `86400`, or Unix seconds) |
| `SERVICES` | `sonarr,radarr,prowlarr,lidarr,jellyseerr,qbittorrent,jellyfin,readarr,mylar3` | Comma-separated service/container names |

## How It Works

1. **Log streaming** — connects to the Docker socket (`/var/run/docker.sock`, read-only) and tails the multiplexed log stream for each configured container. Logs are parsed for timestamp, level, and multi-line continuations.

2. **Suggestions** — 12 rules evaluate recent log entries (5-60 minute windows) using pattern matching and frequency heuristics. Each suggestion links to a runbook entry and/or a resolver.

3. **Runbook** — a library of 11 common problems with symptoms, causes, and resolution steps. Filter by service and expand entries inline.

4. **Resolvers** — automated fix sequences with typed steps:
   - `restart` — Docker container restart
   - `wait` — configurable delay
   - `host` — shell command via `curl` or `docker exec`
   - `api` — HTTP call with API key (read from Settings or extracted from container config)

   Resolvers respect your configured **API keys** and **service URLs** from the Settings panel.

## Resolvers

| Resolver | Service | Steps | Description |
|----------|---------|-------|-------------|
| **Restart service** | general | 2 | Restart any configured service (multi-select) |
| **Reannounce torrents** | qBittorrent | 2 | Force reannounce + recheck all torrents |
| **Force search (Radarr)** | Radarr | 3 | Trigger MissingMoviesSearch + RefreshMonitoredDownloads |
| **Force search (Sonarr)** | Sonarr | 3 | Trigger MissingEpisodeSearch + RefreshMonitoredDownloads |
| **Refresh library** | Jellyfin | 3 | Full library rescan via Jellyfin API |

## Settings

The ⚙ drawer stores per-service configuration in `data/settings.json`:

- **API Key** — used by resolvers for `api` steps. Automatically extracted from container config files via `docker exec` if not configured.
- **Service URL** — override the auto-detected Docker URL (useful when services run on different hosts).

Settings persist across container rebuilds and restarts.

## Non-Docker Setups

If you run services without Docker (bare-metal, systemd, Kubernetes, etc.):

1. Set `SERVICES` to match your service names (used only as display labels)
2. Open the ⚙ Settings drawer
3. Enter the **URL** for each service (e.g., `http://192.168.1.50:8989`)
4. Enter the **API Key** for each service

Log streaming and container restart resolvers are not available without Docker socket access — but API-based resolvers (force search, library refresh) still work with the configured URLs and keys.

## Security

- The Docker socket is mounted **read-only**. The container can only inspect containers, read logs, and restart known services.
- All HTTP communication is local within the Docker network. Expose it behind a reverse proxy with authentication if you need external access.
- API keys stored in settings are only used for authenticated requests to the \*arr services from within the container.

## Development

```bash
npm install
npm run dev         # tsx watch + Vite dev server
npm run build       # production build
npm run typecheck   # TypeScript check
```

## Tech Stack

- **Backend**: Fastify (Node.js) + SSE + Docker Unix socket
- **Frontend**: React 18 + Vite + TypeScript
- **Container**: multi-stage Alpine (node:22-alpine) with curl & docker-cli

## License

MIT
