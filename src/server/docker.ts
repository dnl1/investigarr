import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ContainerSummary, LogEntry, LogEntryMeta, Service, ServiceStatus } from "./types.js";
import { detectLevel } from "./log-level.js";

const DOCKER_LOGS = process.env.DOCKER_LOGS || "/var/lib/docker/containers";

interface ContainerConfig {
  Name: string;
  State: { Running: boolean; Paused: boolean; Restarting: boolean; Dead: boolean; StartedAt: string; FinishedAt: string };
  Config: { Image: string; Cmd: string[]; Env: string[] };
}

function containerState(s: ContainerConfig["State"]): string {
  if (s.Dead) return "dead";
  if (s.Restarting) return "restarting";
  if (s.Paused) return "paused";
  if (s.Running) return "running";
  return "exited";
}

interface DiscoveredContainer {
  id: string;
  config: ContainerConfig;
}

function discoverContainers(): DiscoveredContainer[] {
  let ids: string[];
  try {
    ids = fs.readdirSync(DOCKER_LOGS);
  } catch {
    return [];
  }

  const results: DiscoveredContainer[] = [];
  for (const id of ids) {
    if (id.length !== 64 || !/^[a-f0-9]+$/.test(id)) continue;
    try {
      const config: ContainerConfig = JSON.parse(
        fs.readFileSync(path.join(DOCKER_LOGS, id, "config.v2.json"), "utf8")
      );
    if (config.Name) {
      // Sometimes configs have a leading / on the name, normalize it
      if (typeof config.Name === "string" && config.Name.startsWith("/")) {
        config.Name = config.Name.slice(1);
      }
      results.push({ id, config });
    }
  } catch {
      // skip unreadable
    }
  }
  return results;
}

export function listContainers(): ContainerSummary[] {
  return discoverContainers().map(({ id, config }) => ({
    Id: id,
    Names: ["/" + config.Name],
    Image: config.Config?.Image ?? "",
    State: containerState(config.State),
    Status: config.State?.Running ? "running" : "stopped"
  }));
}

export function getServiceStatuses(services: Service[]): ServiceStatus[] {
  const containers = discoverContainers();

  return services.map((service) => {
    const c = containers.find((c) => c.config.Name === service.container);
    return {
      ...service,
      id: c?.id ?? null,
      image: c?.config.Config?.Image ?? null,
      state: c ? containerState(c.config.State) : "missing",
      status: c?.config.State?.Running ? "running" : (c ? "stopped" : null)
    };
  });
}

export function streamContainerLogs(options: {
  service: Service;
  tail: number;
  since?: string;
  meta?: LogEntryMeta | null;
  onEntry: (entry: LogEntry) => void;
  onError: (error: Error) => void;
  onEnd?: () => void;
}): () => void {
  const container = discoverContainers().find(
    (c) => c.config.Name === options.service.container
  );

  if (!container) {
    options.onError(new Error(`Container not found: ${options.service.container}`));
    return () => {};
  }

  const logFile = path.join(DOCKER_LOGS, container.id, `${container.id}-json.log`);
  let destroyed = false;
  let filePos = 0;

  // Cap on how many bytes to read on the initial pass — avoids OOM on large log files
  const MAX_INITIAL_BYTES = 2 * 1024 * 1024;

  function parseLogLine(raw: string): LogEntry | null {
    try {
      const parsed = JSON.parse(raw);
      const message = (parsed.log ?? "").replace(/\n$/, "");
      if (!message) return null;
      const timestamp = parsed.time || new Date().toISOString();
      return {
        id: randomUUID(),
        service: options.service.name,
        container: options.service.container,
        timestamp,
        level: detectLevel(message),
        message,
        meta: options.meta ?? null
      };
    } catch {
      return null;
    }
  }

  function readSince(ts: string): number | null {
    const trimmed = ts.trim();
    if (!trimmed) return null;
    if (/^\d+$/.test(trimmed)) return Number(trimmed);
    const m = trimmed.match(/^(\d+)(s|m|h|d)$/i);
    if (m) {
      const mul = { s: 1, m: 60, h: 3600, d: 86400 }[m[2].toLowerCase()] ?? 1;
      return Math.floor(Date.now() / 1000) - Number(m[1]) * mul;
    }
    const parsed = Date.parse(trimmed);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }

  const sinceUnix = options.since ? readSince(options.since) : null;

  // Initial tail + history read
  let initialDone = false;
  let initialBuf: LogEntry[] = [];

  function readAndEmit(pos: number, emit: boolean): number {
    try {
      const stat = fs.statSync(logFile);
      const newSize = stat.size;
      // File truncated or rotated — reset position
      if (newSize < pos) pos = 0;
      if (newSize === pos) return pos;

      // On the initial pass, cap the read to the last MAX_INITIAL_BYTES to avoid OOM
      const startPos = !initialDone && newSize - pos > MAX_INITIAL_BYTES
        ? newSize - MAX_INITIAL_BYTES
        : pos;

      let text: string;
      const fd = fs.openSync(logFile, "r");
      try {
        const len = newSize - startPos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, startPos);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split("\n");
      // If we jumped into the middle of the file, the first line may be partial — skip it
      const processLines = startPos > pos ? lines.slice(1) : lines;

      for (const line of processLines) {
        if (!line) continue;
        const entry = parseLogLine(line);
        if (!entry) continue;

        if (sinceUnix !== null) {
          const entryUnix = Math.floor(Date.parse(entry.timestamp) / 1000);
          if (Number.isNaN(entryUnix) || entryUnix < sinceUnix) continue;
        }

        if (!initialDone) {
          initialBuf.push(entry);
          continue;
        }

        if (emit && !destroyed) options.onEntry(entry);
      }

      return newSize;
    } catch {
      return pos;
    }
  }

  // First pass: read the tail of the file to collect entries
  filePos = readAndEmit(0, false);

  // Apply tail
  const tailSlice = initialBuf.length > options.tail
    ? initialBuf.slice(-options.tail)
    : initialBuf;
  for (const entry of tailSlice) {
    if (!destroyed) options.onEntry(entry);
  }
  initialDone = true;

  // Watch for changes
  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(logFile, (event) => {
      if (destroyed) return;
      // 'rename' fires on log rotation — reset position so the new file is read from start
      if (event === "rename") filePos = 0;
      filePos = readAndEmit(filePos, true);
    });
    watcher.on("error", (err) => {
      if (!destroyed) options.onError(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (err) {
    if (!destroyed) {
      options.onError(err instanceof Error ? err : new Error(String(err)));
    }
  }

  // Poll fallback for file rotation / edge cases
  const pollTimer = setInterval(() => {
    if (destroyed) return;
    filePos = readAndEmit(filePos, true);
  }, 2000);

  return () => {
    destroyed = true;
    watcher?.close();
    clearInterval(pollTimer);
  };
}

export function restartContainer(_containerName: string): never {
  throw new Error(
    "Container restart requires Docker API access, which is not available in filesystem-only mode. " +
    "Restart the container from the host or configure a systemd timer."
  );
}
