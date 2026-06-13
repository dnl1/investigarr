import fs from "node:fs";
import path from "node:path";

const DOCKER_LOGS = process.env.DOCKER_LOGS || "/var/lib/docker/containers";

export type LogSourceType = "file" | "journald" | "none";

export interface LogSource {
  type: LogSourceType;
  path?: string;
  unit?: string;
}

function findDockerLogFile(containerName: string): string | null {
  let ids: string[];
  try {
    ids = fs.readdirSync(DOCKER_LOGS);
  } catch { return null; }

  for (const id of ids) {
    if (id.length !== 64 || !/^[a-f0-9]+$/.test(id)) continue;
    try {
      const raw = fs.readFileSync(path.join(DOCKER_LOGS, id, "config.v2.json"), "utf8");
      const config = JSON.parse(raw);
      const name = String(config?.Name ?? "").replace(/^\//, "");
      if (name === containerName) {
        const logFile = path.join(DOCKER_LOGS, id, `${id}-json.log`);
        if (fs.existsSync(logFile)) return logFile;
      }
    } catch { /* skip unreadable */ }
  }
  return null;
}

const JOURNALCTL_PATHS = ["/usr/bin/journalctl", "/bin/journalctl", "/usr/local/bin/journalctl"];

function journalctlAvailable(): boolean {
  return JOURNALCTL_PATHS.some((p) => {
    try { return fs.statSync(p).isFile(); } catch { return false; }
  });
}

// Returns the best available log source for a given container name.
// Resolution order:
//   1. User-configured file path (from Settings)
//   2. Docker JSON log file (auto-discovered via filesystem scan)
//   3. systemd journald unit (native deployments with journalctl)
//   4. none — caller should surface an error to the user
export function discoverLogSource(containerName: string, userLogPath?: string): LogSource {
  if (userLogPath?.trim()) {
    return { type: "file", path: userLogPath.trim() };
  }

  const dockerFile = findDockerLogFile(containerName);
  if (dockerFile) return { type: "file", path: dockerFile };

  if (journalctlAvailable()) {
    return { type: "journald", unit: `${containerName}.service` };
  }

  return { type: "none" };
}
