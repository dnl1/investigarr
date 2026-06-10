export type RunbookStep = {
  text: string;
  command?: string;
  action?: { label: string; container: string };
};

export type RunbookEntry = {
  id: string;
  title: string;
  description: string;
  service: string;
  severity: "info" | "warning" | "error";
  symptoms: string[];
  causes: string[];
  steps: RunbookStep[];
};

export const runbook: RunbookEntry[] = [
  {
    id: "qbittorrent-connection",
    title: "qBittorrent Connection Failures",
    description: "Sonarr or Radarr cannot communicate with qBittorrent — connections are being reset or timing out.",
    service: "qbittorrent",
    severity: "error",
    symptoms: [
      "Connection reset by peer when Sonarr/Radarr tries to reach qBittorrent",
      "Unable to retrieve queue and history items from qBittorrent",
      "HttpRequestException: An error occurred while sending the request"
    ],
    causes: [
      "qBittorrent is overloaded with concurrent connections",
      "Container ran out of memory and the kernel killed its connections",
      "qBittorrent WebUI is temporarily unresponsive after restart",
      "Too many torrents in the queue causing slow API responses"
    ],
    steps: [
      { text: "Restart the qBittorrent container", command: "docker restart qbittorrent", action: { label: "Restart qBittorrent", container: "qbittorrent" } },
      { text: "Check qBittorrent resource usage (CPU, memory)", command: "docker stats qbittorrent --no-stream" },
      { text: "Verify the WebUI responds", command: "curl -s -o /dev/null -w '%{http_code}' http://qbittorrent:8081" },
      { text: "In Sonarr/Radarr, test the download client connection under Settings > Download Clients" }
    ]
  },
  {
    id: "auth-failures",
    title: "Unauthenticated API Requests",
    description: "Services are receiving HTTP requests without valid authentication headers.",
    service: "general",
    severity: "warning",
    symptoms: [
      "Authorization header missing log messages every few seconds",
      "Basic was not authenticated: Failure message: Authorization header missing",
      "401 Unauthorized responses in service logs"
    ],
    causes: [
      "Nginx Proxy Manager healthcheck probes hitting the backend directly",
      "A client or integration is using the wrong API key or no key",
      "Reverse proxy not forwarding authentication headers correctly",
      "Another service polling the API without credentials"
    ],
    steps: [
      { text: "Check if NPM healthcheck is the source — review NPM proxy config for the affected domain" },
      { text: "If using Jellyseerr, verify the Jellyfin API key is correct under Settings > General" },
      { text: "For Sonarr/Radarr, check that API key in connecting apps matches config.xml", command: "grep ApiKey /mnt/data/sonarr/config.xml" },
      { text: "Add the Docker subnet to trusted proxies if behind a reverse proxy" }
    ]
  },
  {
    id: "connection-refused",
    title: "Connection Refused Between Services",
    description: "A container cannot establish a TCP connection to another container in the same Docker network.",
    service: "docker",
    severity: "error",
    symptoms: [
      "Connection refused or ECONNREFUSED in service logs",
      "Could not connect to remote host",
      "Service discovery or hostname resolution failures"
    ],
    causes: [
      "The target container is not running or has crashed",
      "The target container is on a different Docker network",
      "The target container started up slower and isn't ready yet",
      "Wrong hostname or port being used in configuration"
    ],
    steps: [
      { text: "Verify the target container is running", command: "docker ps --filter name=TARGET_SERVICE" },
      { text: "Check both containers share the same Docker network", command: "docker inspect TARGET_SOURCE --format '{{range $net,$v := .NetworkSettings.Networks}}{{$net}} {{end}}'" },
      { text: "Test connectivity from the source container", command: "docker exec TARGET_SOURCE curl -s http://TARGET:PORT" },
      { text: "Review docker-compose.yml to ensure correct network assignments" }
    ]
  },
  {
    id: "download-client",
    title: "Download Client Unreachable",
    description: "Sonarr, Radarr, or Lidarr cannot fetch the queue or history from the configured download client.",
    service: "general",
    severity: "warning",
    symptoms: [
      "Unable to retrieve queue and history items from qBittorrent",
      "Download client tests fail in Sonarr/Radarr settings",
      "Downloads are stuck in 'queued' state without progressing"
    ],
    causes: [
      "Download client (qBittorrent, SABnzbd, etc.) is down or restarting",
      "API credentials changed in the download client",
      "Network issue between the *arr service and the download client",
      "Download client is busy with I/O and not responding in time"
    ],
    steps: [
      { text: "Restart the download client", action: { label: "Restart qBittorrent", container: "qbittorrent" } },
      { text: "Check if the client's WebUI is accessible", command: "curl -s -o /dev/null -w '%{http_code}' http://qbittorrent:8081" },
      { text: "Test the connection in Sonarr/Radarr: Settings > Download Clients > Test" },
      { text: "Verify credentials match between the *arr and the download client" }
    ]
  },
  {
    id: "oom-crash",
    title: "Container Killed (Out of Memory)",
    description: "A container was killed by the kernel due to hitting memory limits.",
    service: "general",
    severity: "error",
    symptoms: [
      "Container exits with code 137 (SIGKILL)",
      "Out of memory or Killed messages in logs",
      "Service becomes unresponsive before disappearing"
    ],
    causes: [
      "Container memory limit is too low for the workload",
      "Memory leak in the application (especially during large imports/scans)",
      "Too many concurrent operations (imports, scans, downloads)",
      "Host is under memory pressure and OOM killer targets containers"
    ],
    steps: [
      { text: "Increase the container's memory limit in docker-compose.yml", command: "mem_limit: 2G" },
      { text: "Check current memory usage of all containers", command: "docker stats --no-stream" },
      { text: "Check host memory and swap usage", command: "free -h" },
      { text: "Restart the container after increasing limits", action: { label: "Restart container", container: "" } },
      { text: "Consider adding swap space if the host is low on memory" }
    ]
  },
  {
    id: "db-locked",
    title: "Database Locked / Migration Failed",
    description: "SQLite database is locked or schema migrations are failing, preventing the service from starting.",
    service: "general",
    severity: "error",
    symptoms: [
      "database is locked errors in logs",
      "Migration failed or Apply Migrations error on startup",
      "Service fails to start or crashes immediately"
    ],
    causes: [
      "Multiple instances of the service accessing the same database file",
      "Unclean shutdown left the database in a locked state",
      "Database file permissions are incorrect",
      "Database file is stored on a network filesystem (NFS/CIFS) with locking issues"
    ],
    steps: [
      { text: "Stop the container and check for stale lock files", command: "docker stop SERVICE_NAME && ls -la /path/to/db/*.db-wal /path/to/db/*.db-shm" },
      { text: "Delete stale WAL/SHM files (if service is stopped)", command: "rm -f /path/to/db/*.db-wal /path/to/db/*.db-shm" },
      { text: "Verify database file permissions", command: "ls -la /path/to/db/*.db" },
      { text: "Restart the container", action: { label: "Restart container", container: "" } },
      { text: "Restore from a recent backup if the database is corrupted" }
    ]
  },
  {
    id: "flaresolverr-timeout",
    title: "FlareSolverr Timeout / Challenges",
    description: "FlareSolverr is timing out or failing to solve Cloudflare challenges for indexers.",
    service: "prowlarr",
    severity: "warning",
    symptoms: [
      "FlareSolverr timeout or challenge failure in Prowlarr logs",
      "Indexers behind Cloudflare returning 403 or empty results",
      "Max timeout reached for challenge resolution"
    ],
    causes: [
      "Cloudflare challenge is too complex for FlareSolverr to solve",
      "FlareSolverr is overloaded with too many concurrent requests",
      "FlareSolverr is running out of memory (headless browser)",
      "Too many indexers using FlareSolverr simultaneously"
    ],
    steps: [
      { text: "Restart FlareSolverr", action: { label: "Restart FlareSolverr", container: "flaresolverr" } },
      { text: "Check FlareSolverr resource usage", command: "docker stats flaresolverr --no-stream" },
      { text: "Increase FlareSolverr timeout in Prowlarr indexer settings" },
      { text: "Consider reducing the number of indexers using FlareSolverr" },
      { text: "Update FlareSolverr to the latest version" }
    ]
  },
  {
    id: "intermittent-indexers",
    title: "Intermittent Indexers / Trackers",
    description: "Prowlarr is repeatedly reporting the same indexer as unavailable, timed out, or returning transient connection failures.",
    service: "prowlarr",
    severity: "warning",
    symptoms: [
      "Cardigann reports '<indexer> server is currently unavailable' repeatedly",
      "Request for the same indexer failed multiple times",
      "HTTP request timed out or response ended prematurely for the same tracker/indexer"
    ],
    causes: [
      "The public tracker is unstable or rate-limiting requests",
      "Cloudflare/anti-bot challenges are intermittently failing",
      "DNS/SSL/network issues affect that tracker specifically",
      "The indexer returns unreliable results and slows RSS/search cycles"
    ],
    steps: [
      { text: "Open Prowlarr > Indexers and test the named indexer manually" },
      { text: "If the same indexer fails repeatedly, disable it first instead of deleting immediately" },
      { text: "If disabling improves searches/RSS and the indexer remains flaky, remove it from Prowlarr" },
      { text: "For Cloudflare-protected indexers, also check FlareSolverr health before removing the indexer" }
    ]
  },
  {
    id: "intermittent-torrent-candidates",
    title: "Intermittent / Bad Torrent Candidates",
    description: "A download repeatedly appears as stalled, incomplete, or failing import. If recovery does not work, the torrent is a removal candidate.",
    service: "qbittorrent",
    severity: "warning",
    symptoms: [
      "The same release repeatedly appears in stalled or stuck download logs",
      "Import keeps failing for the same torrent/release",
      "Download never completes even after reannounce/recheck"
    ],
    causes: [
      "Torrent has no usable seeders or peers",
      "Torrent metadata/files do not match what Sonarr/Radarr expects",
      "Release is incomplete or broken",
      "Tracker is intermittent and cannot keep the swarm reachable"
    ],
    steps: [
      { text: "Try reannounce/recheck once before removal", action: { label: "Reannounce torrents", container: "qbittorrent" } },
      { text: "If it remains stalled, remove the torrent in qBittorrent with files only if no library import exists" },
      { text: "Trigger a manual search in Sonarr/Radarr and pick another release" },
      { text: "Prefer torrents with active seeders and from indexers that are not currently failing" }
    ]
  },
  {
    id: "disk-space",
    title: "Low Disk Space / No Space Left",
    description: "The host or container volume is running out of disk space, causing write failures.",
    service: "general",
    severity: "error",
    symptoms: [
      "No space left on device errors",
      "Downloads failing with disk write errors",
      "Services becoming read-only or crashing on write attempts",
      "Docker overlay filesystem errors"
    ],
    causes: [
      "Media storage partition is full",
      "Docker log files have grown unchecked (json-file logging driver)",
      "Incomplete downloads accumulating in the download folder",
      "Trailers, metadata, or cache directories consuming space"
    ],
    steps: [
      { text: "Check disk usage on all mounted volumes", command: "df -h" },
      { text: "Find the largest directories consuming space", command: "du -sh /* 2>/dev/null | sort -rh | head -10" },
      { text: "Clean up Docker logs for all containers", command: "docker system df && docker system prune -af" },
      { text: "Check download client's incomplete folder for stuck downloads" },
      { text: "Set up Docker log rotation in /etc/docker/daemon.json", command: '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' }
    ]
  },
  {
    id: "rss-sync-stalled",
    title: "RSS Sync Not Processing Releases",
    description: "RSS sync runs but grabs 0 releases, or indexers return no results.",
    service: "general",
    severity: "warning",
    symptoms: [
      "RSS Sync Completed. Reports found: 0, Reports grabbed: 0",
      "No releases found for any monitored show/movie",
      "Indexers are enabled but not returning results"
    ],
    causes: [
      "Indexers are temporarily down or rate-limited",
      "FlareSolverr is failing and blocking Cloudflare-protected indexers",
      "Indexer categories don't match what the *arr service is requesting",
      "Prowlarr's connection to indexers is failing"
    ],
    steps: [
      { text: "Check Prowlarr for indexer status (green checkmark = OK)", command: "curl -s http://prowlarr:9696/api/v1/indexer?apiKey=YOUR_KEY | jq '.[].status'" },
      { text: "Restart FlareSolverr if indexers use Cloudflare", action: { label: "Restart FlareSolverr", container: "flaresolverr" } },
      { text: "Manually test an indexer search in Prowlarr UI" },
      { text: "Check if indexer API limits have been reached (429 Too Many Requests)" },
      { text: "Verify indexer categories are properly mapped in the *arr service" }
    ]
  }
];

export function getRunbookEntry(id: string): RunbookEntry | undefined {
  return runbook.find((e) => e.id === id);
}

export function getRunbookByService(service: string): RunbookEntry[] {
  if (service === "all") return runbook;
  return runbook.filter((e) => e.service === service || e.service === "general");
}
