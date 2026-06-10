import http from "node:http";
import { randomUUID } from "node:crypto";
import type { ContainerSummary, LogEntry, LogEntryMeta, Service, ServiceStatus } from "./types.js";
import { detectLevel } from "./log-level.js";

const socketPath = "/var/run/docker.sock";

function dockerRequest(path: string, method = "GET"): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path, method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        const body = Buffer.concat(chunks);
        if ((res.statusCode ?? 500) >= 400) {
          reject(new Error(`Docker API ${res.statusCode}: ${body.toString("utf8")}`));
          return;
        }
        resolve(body);
      });
    });

    req.on("error", reject);
    req.end();
  });
}

export async function listContainers(): Promise<ContainerSummary[]> {
  const body = await dockerRequest("/containers/json?all=true");
  return JSON.parse(body.toString("utf8")) as ContainerSummary[];
}

export async function getServiceStatuses(services: Service[]): Promise<ServiceStatus[]> {
  const containers = await listContainers();

  return services.map((service) => {
    const container = containers.find((item) => item.Names.includes(`/${service.container}`));
    return {
      ...service,
      id: container?.Id ?? null,
      image: container?.Image ?? null,
      state: container?.State ?? "missing",
      status: container?.Status ?? null
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
}): () => void {
  const searchParams = new URLSearchParams({
    stdout: "true",
    stderr: "true",
    follow: "true",
    timestamps: "true",
    tail: String(options.tail)
  });

  if (options.since) {
    const since = toDockerSince(options.since);
    if (since) searchParams.set("since", since);
  }

  const req = http.request(
    {
      socketPath,
      path: `/containers/${encodeURIComponent(options.service.container)}/logs?${searchParams.toString()}`,
      method: "GET"
    },
    (res) => {
      if ((res.statusCode ?? 500) >= 400) {
        let errorBody = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          errorBody += chunk;
        });
        res.on("end", () => options.onError(new Error(errorBody || `Docker API ${res.statusCode}`)));
        return;
      }

      let pending: { timestamp: string; message: string } | null = null;

      function flushPending() {
        if (!pending) return;
        // Strip ANSI escape sequences from the raw Docker log multiplexed stream
        const sanitized = pending.message.replace(/\x1b\[[0-9;]*m/g, "");
        options.onEntry({
          id: randomUUID(),
          service: options.service.name,
          container: options.service.container,
          timestamp: pending.timestamp,
          level: detectLevel(sanitized),
          message: sanitized,
          meta: options.meta ?? null
        });
        pending = null;
      }

      parseDockerLogStream(res, (line) => {
        const { timestamp, message } = parseTimestamp(line);

        if (pending && /^\s/.test(message)) {
          pending.message += "\n" + message;
          return;
        }

        flushPending();
        pending = { timestamp, message };
      });

      res.on("end", flushPending);
    }
  );

  req.on("error", options.onError);
  req.end();

  return () => req.destroy();
}

export async function restartContainer(containerName: string): Promise<void> {
  await dockerRequest(`/containers/${encodeURIComponent(containerName)}/restart`, "POST");
}

function parseDockerLogStream(stream: NodeJS.ReadableStream, onLine: (line: string) => void) {
  let buffer = Buffer.alloc(0);
  let textBuffer = "";

  stream.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length > 0) {
      if (looksLikeMultiplexFrame(buffer)) {
        if (buffer.length < 8) return;
        const payloadLength = buffer.readUInt32BE(4);
        if (buffer.length < 8 + payloadLength) return;
        const payload = buffer.subarray(8, 8 + payloadLength);
        buffer = buffer.subarray(8 + payloadLength);
        textBuffer = emitLines(textBuffer + payload.toString("utf8"), onLine);
        continue;
      }

      textBuffer = emitLines(textBuffer + buffer.toString("utf8"), onLine);
      buffer = Buffer.alloc(0);
    }
  });

  stream.on("end", () => {
    if (textBuffer.trim().length > 0) {
      onLine(textBuffer.trimEnd());
    }
  });
}

function looksLikeMultiplexFrame(buffer: Buffer): boolean {
  return buffer.length >= 8 && (buffer[0] === 1 || buffer[0] === 2) && buffer[1] === 0 && buffer[2] === 0 && buffer[3] === 0;
}

function emitLines(text: string, onLine: (line: string) => void): string {
  const lines = text.split(/\r?\n/);
  const remainder = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim().length > 0) onLine(line);
  }
  return remainder;
}

function parseTimestamp(line: string): { timestamp: string; message: string } {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\S+)\s+(.*)$/);
  if (!match) {
    return { timestamp: new Date().toISOString(), message: line };
  }

  return { timestamp: match[1], message: match[2] };
}

function toDockerSince(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  if (/^\d+$/.test(trimmed)) return trimmed;

  const duration = trimmed.match(/^(\d+)(s|m|h|d)$/i);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2].toLowerCase();
    const multiplier = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
    return String(Math.floor(Date.now() / 1000) - amount * multiplier);
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) return String(Math.floor(timestamp / 1000));

  return null;
}
