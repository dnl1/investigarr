import type { LogLevel } from "./types.js";

export const orderedLevels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"];

const prefixToLevel: Record<string, LogLevel> = {
  "[fatal]": "fatal", "[ftl]": "fatal",
  "[error]": "error", "[err]": "error",
  "[warn]": "warn", "[warning]": "warn", "[wrn]": "warn",
  "[info]": "info", "[inf]": "info",
  "[debug]": "debug", "[dbg]": "debug",
  "[trace]": "trace", "[verbose]": "trace", "[trc]": "trace",
  " error ": "error", " warn ": "warn", " info ": "info", " debug ": "debug", " trace ": "trace", " fatal ": "fatal"
};

export function detectLevel(message: string): LogLevel {
  // Strip ANSI escape sequences (ESC[...m) that may surround the level keyword
  const cleaned = message.replace(/\x1b\[[0-9;]*m/g, "");
  const text = cleaned.toLowerCase();

  // Respect explicit level prefix — both long form ([Info], [Error])
  // used by *arr apps, and abbreviated form ([INF], [ERR]) used by Jellyfin/Emby.
  const bracketMatch = text.match(/\[([a-z]{3,7})\]/);
  if (bracketMatch) {
    const tag = `[${bracketMatch[1]}]`;
    if (prefixToLevel[tag]) return prefixToLevel[tag];
  }

  // Fallback to keyword heuristics (ordered by specificity)
  if (/\b(fatal|panic|critical)\b/.test(text)) return "fatal";
  if (/\b(error|erro|exception|failed|failure|fail|err:)\b/.test(text)) return "error";
  if (/\b(warn|warning|aviso|deprecated)\b/.test(text)) return "warn";
  if (/\b(debug|dbg)\b/.test(text)) return "debug";
  if (/\b(trace|verbose)\b/.test(text)) return "trace";
  if (/\b(info|information|notice)\b/.test(text)) return "info";

  return "unknown";
}

export function shouldIncludeLevel(level: LogLevel, selected: Set<string>): boolean {
  return selected.size === 0 || selected.has(level) || (level === "unknown" && selected.has("info"));
}
