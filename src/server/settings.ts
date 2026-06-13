import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serviceColor, servicePorts, services } from "./config.js";
import type { Service } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = path.resolve(__dirname, "../../data/settings.json");

export type ServiceConfig = {
  apiKey: string;
  url: string;
};

export type Settings = {
  apiKeys: Record<string, string>;
  serviceUrls: Record<string, string>;
  customServices: Service[];
};

const DEFAULTS: Settings = {
  apiKeys: {},
  serviceUrls: {},
  customServices: []
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
      serviceUrls: { ...generateDefaults().serviceUrls, ...(parsed.serviceUrls || {}) },
      customServices: sanitizeCustomServices(parsed.customServices || [])
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
  const urls: Record<string, string> = {};
  for (const svc of services) {
    const port = servicePorts[svc.name];
    if (port) {
      urls[svc.name] = `http://${svc.container}:${port}`;
    }
  }
  return { apiKeys: {}, serviceUrls: urls, customServices: [] };
}

export function getSettings(): Settings {
  if (!current) current = load();
  return {
    apiKeys: { ...current.apiKeys },
    serviceUrls: { ...current.serviceUrls },
    customServices: current.customServices.map((svc) => ({ ...svc }))
  };
}

export function updateSettings(partial: Partial<Settings>): Settings {
  const s = getSettings();
  if (partial.apiKeys !== undefined) {
    s.apiKeys = { ...partial.apiKeys };
  }
  if (partial.serviceUrls !== undefined) {
    s.serviceUrls = { ...partial.serviceUrls };
  }
  if (partial.customServices !== undefined) {
    s.customServices = sanitizeCustomServices(partial.customServices);
  }
  save(s);
  return s;
}

export function getAllServices(): Service[] {
  return [...services, ...getSettings().customServices];
}

export function addCustomService(input: { name: string; container: string }): Service {
  const name = input.name.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  const container = input.container.trim();
  if (!name) throw new Error("Service name is required");
  if (!container) throw new Error("Container name is required");
  if (getAllServices().some((svc) => svc.name === name)) throw new Error(`Service already exists: ${name}`);

  const s = getSettings();
  const service: Service = {
    name,
    container,
    color: serviceColor(services.length + s.customServices.length),
    source: "custom"
  };
  updateSettings({ customServices: [...s.customServices, service] });
  return service;
}

export function removeCustomService(name: string): boolean {
  const s = getSettings();
  const next = s.customServices.filter((svc) => svc.name !== name);
  if (next.length === s.customServices.length) return false;
  const apiKeys = { ...s.apiKeys };
  const serviceUrls = { ...s.serviceUrls };
  delete apiKeys[name];
  delete serviceUrls[name];
  updateSettings({ customServices: next, apiKeys, serviceUrls });
  return true;
}

export function lookupApiKey(service: string): string | null {
  const s = getSettings();
  return s.apiKeys[service] ?? null;
}

export function lookupServiceUrl(service: string): string | null {
  const s = getSettings();
  return s.serviceUrls[service] ?? null;
}

function sanitizeCustomServices(input: Service[]): Service[] {
  const defaultNames = new Set(services.map((svc) => svc.name));
  const seen = new Set<string>();
  const result: Service[] = [];
  for (const item of input) {
    const name = String(item.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
    const container = String(item.container ?? "").trim();
    if (!name || !container || defaultNames.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push({
      name,
      container,
      color: item.color || serviceColor(services.length + result.length),
      source: "custom"
    });
  }
  return result;
}
