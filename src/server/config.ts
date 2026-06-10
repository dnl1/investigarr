import { existsSync } from "node:fs";
import type { Service } from "./types.js";

const palette = ["#7c3aed", "#0891b2", "#16a34a", "#d97706", "#dc2626", "#2563eb", "#be185d", "#c026d3", "#0d9488"];

export const port = Number(process.env.PORT ?? 8788);
export const logTail = Number(process.env.LOG_TAIL ?? 250);
export const logSince = process.env.LOG_SINCE ?? "2h";

const defaultServices = "sonarr,radarr,prowlarr,lidarr,jellyseerr,qbittorrent,jellyfin,readarr,mylar3";

export const services: Service[] = (process.env.SERVICES ?? defaultServices)
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean)
  .map((name, index) => ({
    name,
    container: name,
    color: palette[index % palette.length]
  }));

/** Well-known default ports for each service (used for auto-generated URLs). */
export const servicePorts: Record<string, number> = {
  sonarr: 8989,
  radarr: 7878,
  prowlarr: 9696,
  lidarr: 8686,
  jellyseerr: 5055,
  qbittorrent: 8081,
  jellyfin: 8096,
  readarr: 8787,
  mylar3: 8090,
};

/** Check if Docker socket is available. */
export function hasDocker(): boolean {
  try {
    return existsSync("/var/run/docker.sock");
  } catch {
    return false;
  }
}
