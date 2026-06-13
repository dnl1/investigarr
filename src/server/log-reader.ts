import fs from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { detectLevel } from "./log-level.js";
import type { LogEntry, LogEntryMeta, LogLevel, Service } from "./types.js";

const MAX_INITIAL_BYTES = 2 * 1024 * 1024;

export interface LogStreamOptions {
  service: Service;
  tail: number;
  since?: string;
  meta?: LogEntryMeta | null;
  onEntry: (entry: LogEntry) => void;
  onError: (error: Error) => void;
  onEnd?: () => void;
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

function makeEntry(
  service: Service,
  meta: LogEntryMeta | null | undefined,
  message: string,
  timestamp: string,
  levelHint?: string
): LogEntry {
  return {
    id: randomUUID(),
    service: service.name,
    container: service.container,
    timestamp,
    level: detectLevel(levelHint != null ? `${levelHint} ${message}` : message),
    message,
    meta: meta ?? null
  };
}

// Docker JSON-line: {"log":"msg\n","stream":"stdout","time":"..."}
function parseDockerLine(line: string, service: Service, meta: LogEntryMeta | null | undefined): LogEntry | null {
  try {
    const p = JSON.parse(line);
    const message = (p.log ?? "").replace(/\n$/, "");
    if (!message) return null;
    return makeEntry(service, meta, message, p.time || new Date().toISOString());
  } catch { return null; }
}

// Generic structured JSON: try common field names
function parseJsonLine(line: string, service: Service, meta: LogEntryMeta | null | undefined): LogEntry | null {
  try {
    const p = JSON.parse(line);
    if (typeof p !== "object" || p === null) return null;
    const message = p.message ?? p.msg ?? p.log ?? p.text ?? p.MESSAGE;
    if (!message) return null;
    const timestamp = p.timestamp ?? p.time ?? p["@timestamp"] ?? p.ts ?? new Date().toISOString();
    const level = p.level ?? p.severity ?? p.lvl;
    return makeEntry(service, meta, String(message), String(timestamp), level != null ? String(level) : undefined);
  } catch { return null; }
}

// ISO timestamp anywhere in the line
const ISO_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/;

// Plain text: extract ISO timestamp if present, run detectLevel on the full line
function parseTextLine(line: string, service: Service, meta: LogEntryMeta | null | undefined): LogEntry | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const m = trimmed.match(ISO_RE);
  const timestamp = m ? new Date(m[1]).toISOString() : new Date().toISOString();
  return makeEntry(service, meta, trimmed, timestamp);
}

type LogFormat = "docker-json" | "json" | "text";

function detectFormat(line: string): LogFormat {
  try {
    const p = JSON.parse(line);
    if (typeof p === "object" && p !== null) {
      if (typeof p.log === "string" && typeof p.time === "string" && typeof p.stream === "string") {
        return "docker-json";
      }
      return "json";
    }
  } catch { /* fall through */ }
  return "text";
}

// Stream from any file. Format is auto-detected from the first non-empty line.
// Handles Docker JSON-line, generic structured JSON, and plain text.
export function streamFromFile(logFile: string, options: LogStreamOptions): () => void {
  let destroyed = false;
  let filePos = 0;
  let format: LogFormat | null = null;
  let initialDone = false;
  let initialBuf: LogEntry[] = [];
  const sinceUnix = options.since ? readSince(options.since) : null;

  function parseLine(line: string): LogEntry | null {
    if (format === "docker-json") return parseDockerLine(line, options.service, options.meta);
    if (format === "json") return parseJsonLine(line, options.service, options.meta);
    return parseTextLine(line, options.service, options.meta);
  }

  function readAndEmit(pos: number): number {
    try {
      const stat = fs.statSync(logFile);
      const newSize = stat.size;
      if (newSize < pos) pos = 0;
      if (newSize === pos) return pos;

      const startPos = pos === 0 && newSize > MAX_INITIAL_BYTES ? newSize - MAX_INITIAL_BYTES : pos;

      const fd = fs.openSync(logFile, "r");
      let text: string;
      try {
        const len = newSize - startPos;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, startPos);
        text = buf.toString("utf8");
      } finally {
        fs.closeSync(fd);
      }

      const lines = text.split("\n");
      const processLines = startPos > pos ? lines.slice(1) : lines;

      for (const line of processLines) {
        if (!line) continue;
        if (format === null) format = detectFormat(line);
        const entry = parseLine(line);
        if (!entry) continue;

        if (sinceUnix !== null) {
          const entryUnix = Math.floor(Date.parse(entry.timestamp) / 1000);
          if (Number.isNaN(entryUnix) || entryUnix < sinceUnix) continue;
        }

        if (!initialDone) { initialBuf.push(entry); continue; }
        if (!destroyed) options.onEntry(entry);
      }

      return newSize;
    } catch { return pos; }
  }

  filePos = readAndEmit(0);

  const tailSlice = initialBuf.length > options.tail ? initialBuf.slice(-options.tail) : initialBuf;
  for (const entry of tailSlice) {
    if (!destroyed) options.onEntry(entry);
  }
  initialBuf = [];
  initialDone = true;

  let watcher: fs.FSWatcher | null = null;
  try {
    watcher = fs.watch(logFile, (event) => {
      if (destroyed) return;
      if (event === "rename") filePos = 0;
      filePos = readAndEmit(filePos);
    });
    watcher.on("error", (err) => {
      if (!destroyed) options.onError(err instanceof Error ? err : new Error(String(err)));
    });
  } catch (err) {
    if (!destroyed) options.onError(err instanceof Error ? err : new Error(String(err)));
  }

  const pollTimer = setInterval(() => {
    if (destroyed) return;
    filePos = readAndEmit(filePos);
  }, 2000);

  return () => {
    destroyed = true;
    watcher?.close();
    clearInterval(pollTimer);
  };
}

// journald syslog priority → log level
const JOURNALD_LEVEL: Partial<Record<string, LogLevel>> = {
  "0": "fatal", "1": "fatal", "2": "error", "3": "error",
  "4": "warn",  "5": "info",  "6": "info",  "7": "debug"
};

// Stream from a systemd unit via journalctl.
// Uses -n <tail> so journalctl pre-filters the initial burst; live entries stream after.
export function streamFromJournald(unit: string, options: LogStreamOptions): () => void {
  let destroyed = false;
  const sinceUnix = options.since ? readSince(options.since) : null;

  const args = ["--output=json", "--no-pager", "-n", String(options.tail), "-f", "-u", unit];
  if (sinceUnix !== null) args.push("--since", `@${sinceUnix}`);

  const child = spawn("journalctl", args);
  let buf = "";
  let linesReceived = 0;

  child.stdout.on("data", (chunk: Buffer) => {
    if (destroyed) return;
    buf += chunk.toString("utf8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      linesReceived++;
      try {
        const p = JSON.parse(line);
        const message = String(p.MESSAGE ?? "");
        if (!message) continue;
        const tsUs = p.__REALTIME_TIMESTAMP;
        const timestamp = tsUs ? new Date(Number(tsUs) / 1000).toISOString() : new Date().toISOString();
        const entry: LogEntry = {
          id: randomUUID(),
          service: options.service.name,
          container: options.service.container,
          timestamp,
          level: JOURNALD_LEVEL[String(p.PRIORITY)] ?? "info",
          message,
          meta: options.meta ?? null
        };
        if (!destroyed) options.onEntry(entry);
      } catch { /* skip malformed */ }
    }
  });

  child.stderr.on("data", () => { /* suppress journalctl stderr */ });

  child.on("error", (err) => {
    if (!destroyed) options.onError(err);
  });

  child.on("close", (code) => {
    if (destroyed) return;
    if (code !== 0 && linesReceived === 0) {
      options.onError(new Error(`journalctl exited with code ${code} for unit "${unit}"`));
    } else {
      options.onEnd?.();
    }
  });

  return () => {
    destroyed = true;
    child.kill();
  };
}
