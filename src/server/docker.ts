import fs from "node:fs";
import path from "node:path";
import type { ContainerSummary, Service, ServiceStatus } from "./types.js";
import { discoverLogSource } from "./log-source.js";
import { streamFromFile, streamFromJournald, type LogStreamOptions } from "./log-reader.js";
import { getSettings } from "./settings.js";

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

export function streamContainerLogs(options: LogStreamOptions): () => void {
  const logPath = getSettings().logPaths[options.service.name];
  const source = discoverLogSource(options.service.container, logPath);

  if (source.type === "file") return streamFromFile(source.path!, options);
  if (source.type === "journald") return streamFromJournald(source.unit!, options);

  options.onError(new Error(
    `No log source found for "${options.service.name}". ` +
    `Set a log file path in ⚙ Settings or ensure the container is running.`
  ));
  return () => {};
}

export function restartContainer(_containerName: string): never {
  throw new Error(
    "Container restart requires Docker API access, which is not available in filesystem-only mode. " +
    "Restart the container from the host or configure a systemd timer."
  );
}
