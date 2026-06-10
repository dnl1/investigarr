import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { servicePorts, services, hasDocker } from "./config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.resolve(__dirname, "../../data/settings.json");

export type ServiceConfig = {
  apiKey: string;
  url: string;
};

export type Settings = {
  apiKeys: Record<string, string>;
  serviceUrls: Record<string, string>;
};

const DEFAULTS: Settings = {
  apiKeys: {},
  serviceUrls: {}
};

let current: Settings | null = null;

function load(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    const defaults = generateDefaults();
    writeFileSync(SETTINGS_PATH, JSON.stringify(defaults, null, 2));
    return defaults;
  }
  try {
    const raw = readFileSync(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as Settings;
    return {
      apiKeys: { ...DEFAULTS.apiKeys, ...(parsed.apiKeys || {}) },
      serviceUrls: { ...generateDefaults().serviceUrls, ...(parsed.serviceUrls || {}) }
    };
  } catch {
    return generateDefaults();
  }
}

function save(s: Settings): void {
  writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
  current = s;
}

/** Generate default service URLs from well-known ports (respects Docker container names). */
function generateDefaults(): Settings {
  const docker = hasDocker();
  const urls: Record<string, string> = {};
  for (const svc of services) {
    const port = servicePorts[svc.name];
    if (port) {
      urls[svc.name] = `http://${svc.container}:${port}`;
    }
  }
  return { apiKeys: {}, serviceUrls: urls };
}

export function getSettings(): Settings {
  if (!current) current = load();
  return { apiKeys: { ...current.apiKeys }, serviceUrls: { ...current.serviceUrls } };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  const s = getSettings();
  if (partial.apiKeys !== undefined) {
    s.apiKeys = { ...partial.apiKeys };
  }
  if (partial.serviceUrls !== undefined) {
    s.serviceUrls = { ...partial.serviceUrls };
  }
  save(s);
  return s;
}

export function lookupApiKey(service: string): string | null {
  const s = getSettings();
  return s.apiKeys[service] ?? null;
}

export function lookupServiceUrl(service: string): string | null {
  const s = getSettings();
  return s.serviceUrls[service] ?? null;
}
