import { execSync } from "node:child_process";
import { restartContainer } from "./docker.js";
import { lookupApiKey, lookupServiceUrl } from "./settings.js";

export type ResolverStep = {
  label: string;
  type: "restart" | "wait" | "host" | "api";
  container?: string;
  duration?: number;
  command?: string;
  url?: string;
  method?: string;
  body?: unknown;
  apiKeyContainer?: string;
  apiKeyPath?: string;
  apiKeyHeader?: string;
  apiKey?: string;
  apiKeyEnv?: string;
};

export type Resolver = {
  id: string;
  title: string;
  description: string;
  service: string;
  steps: ResolverStep[];
  actionLabel?: string;
  selectableService?: {
    label: string;
    default: string;
    options: Array<{ label: string; value: string }>;
  };
  relevantLogPatterns?: Array<{ service?: string; pattern: RegExp }>;
};

export type ResolverResult = {
  label: string;
  status: "ok" | "fail" | "running";
  error?: string;
  output?: string;
};

export const resolvers: Resolver[] = [
  {
    id: "restart-service",
    title: "Restart service",
    description: "[Unavailable — requires Docker API] Restart a selected service from the host with 'docker restart <container>'.",
    service: "general",
    actionLabel: "Restart",
    selectableService: {
      label: "Service",
      default: "flaresolverr",
      options: [
        { label: "qBittorrent", value: "qbittorrent" },
        { label: "FlareSolverr", value: "flaresolverr" },
        { label: "Jellyfin", value: "jellyfin" },
        { label: "Sonarr", value: "sonarr" },
        { label: "Radarr", value: "radarr" },
        { label: "Seerr", value: "seerr" },
        { label: "Prowlarr", value: "prowlarr" }
      ]
    },
    relevantLogPatterns: [
      { service: "sonarr", pattern: /Connection reset by peer/i },
      { service: "radarr", pattern: /Connection reset by peer/i },
      { service: "sonarr", pattern: /Unable to retrieve queue/i },
      { service: "radarr", pattern: /Unable to retrieve queue/i },
      { service: "prowlarr", pattern: /FlareSolverr|flaresolverr|challenge.*timeout/i },
      { service: "jellyfin", pattern: /OutOfMemory|oom|stuck.*transcode|plugin.*error/i },
      { service: "sonarr", pattern: /NLog|Database.*locked|Too many open files/i },
      { service: "radarr", pattern: /NLog|Database.*locked|Too many open files/i },
      { service: "seerr", pattern: /Error|error|timeout|connection.*refused/i },
      { service: "prowlarr", pattern: /connection refused|ECONNREFUSED|could not connect/i }
    ],
    steps: [
      { label: "Restarting selected service...", type: "restart", container: "__selectedService__" },
      { label: "Waiting for service to settle...", type: "wait", duration: 8000 }
    ]
  },
  {
    id: "reannounce-torrents",
    title: "Force reannounce all torrents",
    description: "Force all qBittorrent torrents to reannounce to trackers. Helps unstuck stalled downloads.",
    service: "qbittorrent",
    relevantLogPatterns: [
      { service: "sonarr", pattern: /stall|stuck|StalledDownload|import.*failed/i },
      { service: "radarr", pattern: /stall|stuck|StalledDownload|import.*failed/i }
    ],
    steps: [
      { label: "Reannouncing all torrents to trackers...", type: "host", command: "curl -s -X POST http://qbittorrent:8081/api/v2/torrents/reannounce -d 'hashes=all' -w ' HTTP_%{http_code}'" },
      { label: "Force recheck of all torrents...", type: "host", command: "curl -s -X POST http://qbittorrent:8081/api/v2/torrents/recheck -d 'hashes=all' -w ' HTTP_%{http_code}'" }
    ]
  },
  {
    id: "force-search-radarr",
    title: "Search all wanted movies",
    description: "Triggers Radarr to search for all missing/wanted movies. Useful when automatic search is stuck or stalled.",
    service: "radarr",
    actionLabel: "Force",
    relevantLogPatterns: [
      { pattern: /no.*search|No.*results|wanted.*queue.*empty|MissingMoviesSearch/i }
    ],
    steps: [
      { label: "Searching for all missing movies...", type: "api", url: "http://radarr:7878/api/v3/command", method: "POST", body: { name: "MissingMoviesSearch" }, apiKeyContainer: "radarr", apiKeyPath: "/config/config.xml" },
      { label: "Waiting for search to propagate...", type: "wait", duration: 3000 },
      { label: "Refreshing monitored downloads...", type: "api", url: "http://radarr:7878/api/v3/command", method: "POST", body: { name: "RefreshMonitoredDownloads" }, apiKeyContainer: "radarr", apiKeyPath: "/config/config.xml" }
    ]
  },
  {
    id: "force-search-sonarr",
    title: "Search all wanted episodes",
    description: "Triggers Sonarr to search for all missing/wanted episodes. Useful when automatic search is stuck.",
    service: "sonarr",
    actionLabel: "Force",
    relevantLogPatterns: [
      { pattern: /no.*search|No.*results|wanted.*queue.*empty|MissingEpisodeSearch/i }
    ],
    steps: [
      { label: "Searching for all missing episodes...", type: "api", url: "http://sonarr:8989/api/v3/command", method: "POST", body: { name: "MissingEpisodeSearch" }, apiKeyContainer: "sonarr", apiKeyPath: "/config/config.xml" },
      { label: "Waiting for search to propagate...", type: "wait", duration: 3000 },
      { label: "Refreshing monitored downloads...", type: "api", url: "http://sonarr:8989/api/v3/command", method: "POST", body: { name: "RefreshMonitoredDownloads" }, apiKeyContainer: "sonarr", apiKeyPath: "/config/config.xml" }
    ]
  },
  {
    id: "jellyfin-library-refresh",
    title: "Refresh Jellyfin library",
    description: "Triggers a full library rescan in Jellyfin (POST /Library/Refresh). Fixes stale file paths when Sonarr/Radarr move or upgrade media.",
    service: "jellyfin",
    relevantLogPatterns: [
      { service: "jellyfin", pattern: /Could not find file/i }
    ],
    steps: [
      { label: "Triggering library refresh...", type: "api", url: "http://jellyfin:8096/Library/Refresh", method: "POST", apiKeyHeader: "X-Emby-Token", apiKeyEnv: "JELLYFIN_API_KEY" },
      { label: "Waiting for scan to start...", type: "wait", duration: 3000 },
      { label: "Checking library scan status...", type: "host", command: "curl -s http://jellyfin:8096/Library/Refresh -H 'X-Emby-Token: {$JELLYFIN_API_KEY}' -o /dev/null -w '%{http_code}'" }
    ]
  }
];

/** Replace `http://<service_name>:<port>/` with the configured service URL (if set) in a URL or command string. Also replaces `{$VAR}` placeholders with env var values. */
function resolveStepUrl(text: string, service: string): string {
  let result = text;
  result = result.replace(/\{\$(\w+)\}/g, (_, name: string) => process.env[name] ?? `{\$${name}}`);
  const configured = lookupServiceUrl(service);
  if (!configured) return result;
  return result.replace(/https?:\/\/[a-zA-Z0-9_.-]+(:\d+)?\//, (match) => {
    const base = configured.replace(/\/$/, "");
    return base.endsWith(match.split("//")[1]?.split("/")[0]) ? match : `${base}/`;
  });
}

function readApiKey(service: string): string {
  const key = lookupApiKey(service);
  if (key) return key;
  throw new Error(
    `No API key configured for ${service}. Open the ⚙ Settings drawer and enter the API key manually. ` +
    `Auto-extraction from container files is not available in filesystem-only mode.`
  );
}

export async function runResolver(id: string, input?: { selectedService?: string }): Promise<{ id: string; results: ResolverResult[] }> {
  const resolver = resolvers.find((r) => r.id === id);
  if (!resolver) throw new Error(`Resolver not found: ${id}`);

  const selectedService = resolver.selectableService
    ? input?.selectedService || resolver.selectableService.default
    : null;
  if (resolver.selectableService && !resolver.selectableService.options.some((opt) => opt.value === selectedService)) {
    throw new Error(`Invalid service selection: ${selectedService}`);
  }

  const results: ResolverResult[] = [];

  for (const step of resolver.steps) {
    try {
      results.push({ label: step.label, status: "running" });

      switch (step.type) {
        case "restart":
          await restartContainer(step.container === "__selectedService__" ? selectedService! : step.container!);
          results[results.length - 1] = { label: step.label, status: "ok" };
          break;
        case "wait":
          await new Promise((resolve) => setTimeout(resolve, step.duration!));
          results[results.length - 1] = { label: step.label, status: "ok" };
          break;
        case "host": {
          const output = execSync(step.command!, { timeout: 30000, encoding: "utf8" }).trim();
          results[results.length - 1] = { label: step.label, status: "ok", output };
          break;
        }
        case "api": {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (step.apiKey) {
            headers[step.apiKeyHeader || "X-Api-Key"] = step.apiKey;
          } else if (step.apiKeyEnv && process.env[step.apiKeyEnv]) {
            headers[step.apiKeyHeader || "X-Api-Key"] = process.env[step.apiKeyEnv]!;
          } else if (step.apiKeyContainer && step.apiKeyPath) {
            const key = readApiKey(resolver.service);
            headers[step.apiKeyHeader || "X-Api-Key"] = key;
          }
          const url = resolveStepUrl(step.url!, resolver.service);
          const response = await fetch(url, {
            method: step.method || "POST",
            headers,
            body: step.body ? JSON.stringify(step.body) : undefined
          });
          const text = await response.text();
          if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
          results[results.length - 1] = { label: step.label, status: "ok", output: `${response.status}` };
          break;
        }
      }
    } catch (err) {
      results[results.length - 1] = {
        label: step.label,
        status: "fail",
        error: err instanceof Error ? err.message : String(err)
      };
      return { id, results };
    }
  }

  return { id, results };
}

export function checkResolverRelevance(resolverId: string, logs: Array<{ service: string; message: string }>): boolean {
  const resolver = resolvers.find((r) => r.id === resolverId);
  if (!resolver?.relevantLogPatterns) return false;
  return resolver.relevantLogPatterns.some((rp) =>
    logs.some((log) => {
      if (rp.service && log.service !== rp.service) return false;
      return rp.pattern.test(log.message);
    })
  );
}
