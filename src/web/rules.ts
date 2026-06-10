export type SuggestionAction = {
  label: string;
  container: string;
};

export type Suggestion = {
  id: string;
  title: string;
  description: string;
  details: string;
  severity: "info" | "warning" | "error";
  action: SuggestionAction | null;
  ref?: string;
  resolverId?: string;
};

type LogEntry = {
  timestamp: string;
  service: string;
  level: string;
  message: string;
};

function recentEntries(entries: LogEntry[], minutes = 5): LogEntry[] {
  const cutoff = Date.now() - minutes * 60 * 1000;
  return entries.filter((e) => {
    const t = new Date(e.timestamp).getTime();
    return !Number.isNaN(t) && t > cutoff;
  });
}

function evidence(entry: LogEntry): string {
  const msg = entry.message.replace(/\s+/g, " ").trim();
  const excerpt = msg.length > 140 ? `${msg.slice(0, 137)}...` : msg;
  return `${entry.service}: ${excerpt}`;
}

function topCount(values: string[]): { value: string; count: number } | null {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const first = sorted[0];
  return first ? { value: first[0], count: first[1] } : null;
}

function extractIndexerName(message: string): string | null {
  const patterns = [
    /Cardigann:\s*([^:\[]+?)\s+server is currently unavailable/i,
    /Request for\s+([^\s]+)\s+failed/i,
    /Searching indexer\(s\):\s*\[([^\]]+)\]/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  const url = message.match(/Unable to connect to indexer \[(https?:\/\/([^\]/]+))/i);
  if (url?.[2]) return url[2].replace(/^www\./, "");
  return null;
}

function extractDownloadName(message: string): string | null {
  const patterns = [
    /SourceTitle[:=]\s*['"]?([^'"\n,]+)/i,
    /release ['"]([^'"]+)['"]/i,
    /download ['"]([^'"]+)['"]/i,
    /torrent ['"]([^'"]+)['"]/i
  ];

  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].trim();
  }

  return null;
}

const rules: Array<{
  id: string;
  title: string;
  description: string;
  severity: "info" | "warning" | "error";
  ref?: string;
  resolverId?: string;
  check: (logs: LogEntry[]) => { active: boolean; details?: string };
  action: SuggestionAction | null;
}> = [
  {
    id: "qbittorrent-connection",
    title: "qBittorrent connection failing",
    description: "Sonarr/Radarr connections are being reset by qBittorrent — likely overload or timeout.",
    severity: "error",
    ref: "qbittorrent-connection",
    resolverId: "restart-service",
    check: (logs) => {
      const recent = recentEntries(logs);
      const fails = recent.filter(
        (e) =>
          (e.service === "sonarr" || e.service === "radarr") &&
          (e.message.includes("Connection reset by peer") || e.message.includes("Unable to retrieve queue"))
      );
      if (fails.length >= 2) {
        return {
          active: true,
          details: `Restart suggested because qBittorrent has ${fails.length} recent connection/queue failures. Evidence: ${evidence(fails[0])}`
        };
      }
      return { active: false };
    },
    action: { label: "Restart qBittorrent", container: "qbittorrent" }
  },
  {
    id: "auth-failures",
    title: "Unauthenticated requests",
    description: "Multiple requests without Authorization header. A client or health probe is misconfigured.",
    severity: "warning",
    ref: "auth-failures",
    check: (logs) => {
      const recent = recentEntries(logs);
      const auths = recent.filter((e) => e.message.includes("Authorization header missing") || e.message.includes("not authenticated"));
      if (auths.length >= 3) {
        const svcs = [...new Set(auths.map((e) => e.service))].join(", ");
        return { active: true, details: `${auths.length} failures on: ${svcs}` };
      }
      return { active: false };
    },
    action: null
  },
  {
    id: "high-error-rate",
    title: "High error rate",
    description: "A service is generating many errors/warnings — may indicate a serious problem.",
    severity: "error",
    check: (logs) => {
      const recent = recentEntries(logs, 3);
      const count = new Map<string, number>();
      for (const e of recent) {
        if (/\[Error\]|\[Warn\]|error|fail|exception/i.test(e.message)) {
          count.set(e.service, (count.get(e.service) || 0) + 1);
        }
      }
      for (const [svc, c] of count) {
        if (c >= 5) return { active: true, details: `${svc}: ${c} occurrences` };
      }
      return { active: false };
    },
    action: null
  },
  {
    id: "download-client-unavailable",
    title: "Download client unreachable",
    description: "MonitoringService cannot fetch the queue from the download client.",
    severity: "warning",
    ref: "download-client",
    resolverId: "restart-service",
    check: (logs) => {
      const recent = recentEntries(logs, 10);
      const fails = recent.filter((e) => /Unable to retrieve.*from/i.test(e.message));
      if (fails.length >= 1) {
        return {
          active: true,
          details: `Restart suggested because the download client queue could not be retrieved. Evidence: ${evidence(fails[0])}`
        };
      }
      return { active: false };
    },
    action: { label: "Restart qBittorrent", container: "qbittorrent" }
  },
  {
    id: "stalled-downloads",
    title: "Torrents stalled or stuck",
    description: "Sonarr/Radarr report downloads are stalled — torrents may need reannounce or recheck.",
    severity: "warning",
    ref: "qbittorrent-connection",
    resolverId: "reannounce-torrents",
    check: (logs) => {
      const recent = recentEntries(logs, 10);
      const stalled = recent.filter((e) => /stall|stuck|StalledDownload|import.*failed|download.*not.*complete/i.test(e.message));
      if (stalled.length >= 1) return { active: true, details: `${stalled.length} stalled events` };
      return { active: false };
    },
    action: { label: "Reannounce torrents", container: "qbittorrent" }
  },
  {
    id: "intermittent-torrent-candidates",
    title: "Torrent candidate may need removal",
    description: "The same download is repeatedly stalled or failing import. If reannounce/recheck does not recover it, remove the torrent and search another release.",
    severity: "warning",
    ref: "intermittent-torrent-candidates",
    check: (logs) => {
      const recent = recentEntries(logs, 60);
      const failures = recent.filter(
        (e) =>
          (e.service === "sonarr" || e.service === "radarr" || e.service === "lidarr") &&
          /stall|stuck|StalledDownload|import.*failed|download.*not.*complete|no files.*eligible/i.test(e.message)
      );
      const named = failures
        .map((e) => extractDownloadName(e.message))
        .filter((name): name is string => Boolean(name));
      const top = topCount(named);

      if (top && top.count >= 2) {
        const sample = failures.find((e) => extractDownloadName(e.message) === top.value) ?? failures[0];
        return {
          active: true,
          details: `Removal suggested because "${top.value}" had ${top.count} repeated stalled/import failure event(s) in the last hour. Evidence: ${evidence(sample)}`
        };
      }

      if (failures.length >= 4) {
        return {
          active: true,
          details: `Review torrent removal candidates: ${failures.length} stalled/import failure event(s) in the last hour. Evidence: ${evidence(failures[0])}`
        };
      }

      return { active: false };
    },
    action: null
  },
  {
    id: "rss-sync",
    title: "RSS Sync completed",
    description: "RSS sync ran successfully — new releases have been processed.",
    severity: "info",
    check: (logs) => {
      const recent = recentEntries(logs, 15);
      const syncs = recent.filter((e) => e.message.includes("RSS Sync Completed"));
      if (syncs.length >= 1) {
        const last = syncs[syncs.length - 1];
        const m = last.message.match(/Reports found: (\d+)/);
        return { active: true, details: `${syncs.length} syncs, ${m ? m[1] : "?"} releases` };
      }
      return { active: false };
    },
    action: null
  },
  {
    id: "connection-refused",
    title: "Connection refused between services",
    description: "A container tried to connect to another and got 'connection refused' — the Docker network may have an issue.",
    severity: "error",
    ref: "connection-refused",
    resolverId: "restart-service",
    check: (logs) => {
      const recent = recentEntries(logs, 5);
      const refs = recent.filter((e) => /connection refused|ECONNREFUSED|could not connect/i.test(e.message));
      if (refs.length >= 1) {
        return {
          active: true,
          details: `Resolver suggested because ${refs.length} recent service connection refusal(s) were detected. Evidence: ${evidence(refs[0])}`
        };
      }
      return { active: false };
    },
    action: null
  },
  {
    id: "flaresolverr-timeout",
    title: "FlareSolverr timeout or unavailable",
    description: "Prowlarr reports FlareSolverr taking too long or not responding.",
    severity: "error",
    ref: "flaresolverr-timeout",
    resolverId: "restart-service",
    check: (logs) => {
      const recent = recentEntries(logs, 10);
      const fails = recent.filter((e) =>
        e.service === "prowlarr" &&
        (e.message.includes("FlareSolverr") || e.message.includes("flaresolverr") || e.message.includes("challenge"))
      );
      if (fails.length >= 1) {
        return {
          active: true,
          details: `Restart suggested because Prowlarr logged ${fails.length} FlareSolverr/challenge error(s). Evidence: ${evidence(fails[0])}`
        };
      }
      return { active: false };
    },
    action: { label: "Restart FlareSolverr", container: "flaresolverr" }
  },
  {
    id: "intermittent-indexers",
    title: "Indexer/tracker may need removal",
    description: "The same Prowlarr indexer is repeatedly timing out or returning transient failures. Consider disabling/removing it if the failures persist.",
    severity: "warning",
    ref: "intermittent-indexers",
    check: (logs) => {
      const recent = recentEntries(logs, 60);
      const failures = recent.filter(
        (e) =>
          e.service === "prowlarr" &&
          /server is currently unavailable|Request for .* failed|Unable to connect to indexer|Http request timed out|response ended prematurely|TooManyRequests|429|temporarily unavailable/i.test(e.message)
      );
      const named = failures
        .map((e) => extractIndexerName(e.message))
        .filter((name): name is string => Boolean(name));
      const top = topCount(named);

      if (top && top.count >= 2) {
        const sample = failures.find((e) => extractIndexerName(e.message) === top.value) ?? failures[0];
        return {
          active: true,
          details: `Removal suggested because "${top.value}" had ${top.count} intermittent failure(s) in the last hour. Evidence: ${evidence(sample)}`
        };
      }

      return { active: false };
    },
    action: null
  },
  {
    id: "jellyfin-missing-files",
    title: "Jellyfin file not found",
    description: "Jellyfin cannot find file(s) on disk — Sonarr/Radarr likely moved or upgraded the media. A library refresh will re-scan paths.",
    severity: "error",
    ref: "jellyfin-missing-files",
    resolverId: "jellyfin-library-refresh",
    check: (logs) => {
      const recent = recentEntries(logs, 15);
      const missing = recent.filter((e) => e.service === "jellyfin" && e.message.includes("Could not find file"));
      if (missing.length >= 1) {
        const files = missing.map((e) => {
          const m = e.message.match(/Could not find file '([^']+)'/);
          return m ? m[1] : "(unknown)";
        });
        const unique = [...new Set(files)];
        return { active: true, details: `${missing.length} errors, ${unique.length} unique files (e.g. ${unique.slice(0, 2).join(", ")})` };
      }
      return { active: false };
    },
    action: { label: "Refresh Jellyfin library", container: "jellyfin" }
  },
  {
    id: "search-needed",
    title: "Wanted movies/episodes not being fetched",
    description: "No recent search activity in Sonarr/Radarr — items may be stuck in wanted queue.",
    severity: "warning",
    resolverId: "force-search-radarr",
    check: (logs) => {
      const recent = recentEntries(logs, 30);
      const hasSearch = recent.some((e) => e.message.includes("Searching") || e.message.includes("searching") || e.message.includes("Search for"));
      const hasQueue = recent.some((e) => e.message.includes("Queue") || e.message.includes("DownloadClient"));
      if (!hasSearch && hasQueue) return { active: true, details: "No recent search commands detected" };
      return { active: false };
    },
    action: null
  }
];

export function evaluateSuggestions(logs: LogEntry[]): Suggestion[] {
  return rules
    .map((rule): Suggestion | null => {
      const result = rule.check(logs);
      if (!result.active) return null;
      return {
        id: rule.id,
        title: rule.title,
        description: rule.description,
        details: result.details ?? "",
        severity: rule.severity,
        action: rule.action,
        ...(rule.ref ? { ref: rule.ref } : {}),
        ...(rule.resolverId ? { resolverId: rule.resolverId } : {})
      };
    })
    .filter((s): s is Suggestion => s !== null);
}
