import { logSince } from "./config.js";
import { getServiceStatuses, streamContainerLogs } from "./docker.js";
import type { LogEntry, Service } from "./types.js";

type Listener = (entry: LogEntry) => void;

const maxServiceBufferEntries = Number(process.env.LOG_BUFFER_PER_SERVICE ?? 500);

export class LogHub {
  private buffers = new Map<string, LogEntry[]>();
  private listeners = new Set<Listener>();
  private closeHandlers = new Map<string, () => void>();
  private restartTimers = new Map<string, NodeJS.Timeout>();
  private started = false;

  constructor(private services: Service[]) {}

  async start() {
    if (this.started) return;
    this.started = true;

    for (const service of this.services) {
      await this.startService(service);
    }
  }

  async setServices(services: Service[]) {
    this.services = services;
    const wanted = new Set(services.map((service) => service.name));

    for (const [name, timer] of this.restartTimers) {
      if (!wanted.has(name)) {
        clearTimeout(timer);
        this.restartTimers.delete(name);
      }
    }

    for (const [name, close] of this.closeHandlers) {
      if (!wanted.has(name)) {
        close();
        this.closeHandlers.delete(name);
        this.buffers.delete(name);
      }
    }

    if (!this.started) return;
    for (const service of services) {
      if (!this.closeHandlers.has(service.name)) await this.startService(service);
    }
  }

  stop() {
    for (const timer of this.restartTimers.values()) clearTimeout(timer);
    for (const close of this.closeHandlers.values()) close();
    this.restartTimers.clear();
    this.closeHandlers.clear();
    this.listeners.clear();
    this.buffers.clear();
    this.started = false;
  }

  recent(options: {
    services: Set<string>;
    levels: Set<string>;
    levelsProvided: boolean;
    search: string;
    limit: number;
  }): LogEntry[] {
    const entries = [...options.services].flatMap((service) => this.buffers.get(service) ?? []);
    return entries
      .filter((entry) => this.matches(entry, options))
      .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
      .slice(0, options.limit)
      .reverse();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  matches(entry: LogEntry, options: {
    services: Set<string>;
    levels: Set<string>;
    levelsProvided: boolean;
    search: string;
  }): boolean {
    if (!options.services.has(entry.service)) return false;
    if (options.levelsProvided && options.levels.size === 0) return true;
    if (options.levels.size > 0 && !options.levels.has(entry.level)) return false;
    if (options.search && !`${entry.service} ${entry.message}`.toLowerCase().includes(options.search)) return false;
    return true;
  }

  private add(entry: LogEntry) {
    const buffer = this.buffers.get(entry.service) ?? [];
    buffer.unshift(entry);
    if (buffer.length > maxServiceBufferEntries) buffer.length = maxServiceBufferEntries;
    this.buffers.set(entry.service, buffer);
    for (const listener of this.listeners) listener(entry);
  }

  private async startService(service: Service) {
    if (!this.started) return;
    this.restartTimers.delete(service.name);
    this.closeHandlers.get(service.name)?.();

    const statuses = await getServiceStatuses([service]);
    const status = statuses[0];
    const meta = status ? { containerId: status.id, image: status.image } : null;

    let close: () => void;
    close = streamContainerLogs({
      service,
      tail: Math.min(maxServiceBufferEntries, 1000),
      since: logSince,
      meta,
      onEntry: (entry) => this.add(entry),
      onError: (error) => {
        if (this.closeHandlers.get(service.name) !== close) return;
        this.add({
          id: `${service.name}-error-${Date.now()}`,
          service: service.name,
          container: service.container,
          timestamp: new Date().toISOString(),
          level: "error",
          message: `Could not read logs: ${error.message}`,
          meta: null
        });
        this.scheduleRestart(service);
      },
      onEnd: () => {
        if (this.closeHandlers.get(service.name) !== close) return;
        this.scheduleRestart(service);
      }
    });

    this.closeHandlers.set(service.name, close);
  }

  private scheduleRestart(service: Service) {
    if (!this.started || this.restartTimers.has(service.name)) return;
    const timer = setTimeout(() => {
      void this.startService(service).catch((error) => {
        this.add({
          id: `${service.name}-error-${Date.now()}`,
          service: service.name,
          container: service.container,
          timestamp: new Date().toISOString(),
          level: "error",
          message: `Could not restart log watcher: ${error instanceof Error ? error.message : String(error)}`,
          meta: null
        });
        this.scheduleRestart(service);
      });
    }, 5000);
    this.restartTimers.set(service.name, timer);
  }
}
