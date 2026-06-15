import { describe, it, expect } from "vitest";
import { evaluateSuggestions } from "./rules.js";

function makeEntry(overrides: Partial<{ service: string; level: string; message: string; timestamp: string }> = {}) {
  const ts = overrides.timestamp ?? new Date().toISOString();
  return {
    service: overrides.service ?? "bazarr",
    container: overrides.service ?? "bazarr",
    timestamp: ts,
    level: overrides.level ?? "error",
    message: overrides.message ?? "",
    id: `${ts}-${Math.random()}`,
    meta: null,
  };
}

describe("bazarr-permission-denied rule", () => {
  it("triggers on PermissionError with Permission denied", () => {
    const logs = [
      makeEntry({
        message:
          "BAZARR Error saving Subtitles file to disk for this file /data/media/Movies/The Godfather (1972)/The.Godfather.1972.1080p.BluRay.DD.5.1.x264-playHD.mkv: PermissionError(13, 'Permission denied')",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    const bazarrSuggestion = suggestions.find((s) => s.id === "bazarr-permission-denied");
    expect(bazarrSuggestion).toBeDefined();
    expect(bazarrSuggestion!.severity).toBe("error");
    expect(bazarrSuggestion!.resolverId).toBe("fix-bazarr-permissions");
    expect(bazarrSuggestion!.details).toContain("The Godfather");
  });

  it("triggers on Error saving Subtitles even without PermissionError text", () => {
    const logs = [
      makeEntry({
        message:
          "ERROR (manual:196) - BAZARR Error saving Subtitles file to disk for this file /data/media/Movies/Some.Movie.mkv: PermissionError",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    expect(suggestions.some((s) => s.id === "bazarr-permission-denied")).toBe(true);
  });

  it("triggers on Permission denied without full PermissionError", () => {
    const logs = [
      makeEntry({
        message: "BAZARR (manual) : Error saving subtitles: Permission denied",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    expect(suggestions.some((s) => s.id === "bazarr-permission-denied")).toBe(true);
  });

  it("does not trigger for non-bazarr services", () => {
    const logs = [
      makeEntry({
        service: "sonarr",
        message: "PermissionError: Cannot write to /config",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    expect(suggestions.some((s) => s.id === "bazarr-permission-denied")).toBe(false);
  });

  it("does not trigger on unrelated bazarr messages", () => {
    const logs = [
      makeEntry({
        message: "BAZARR Successfully downloaded subtitles from provider X",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    expect(suggestions.some((s) => s.id === "bazarr-permission-denied")).toBe(false);
  });

  it("does not trigger on old stale logs", () => {
    const oldDate = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    const logs = [
      makeEntry({
        timestamp: oldDate,
        message: "BAZARR Error saving Subtitles file: Permission denied",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    expect(suggestions.some((s) => s.id === "bazarr-permission-denied")).toBe(false);
  });

  it("has correct action label and container", () => {
    const logs = [
      makeEntry({
        message: "BAZARR Error saving Subtitles file to disk: PermissionError(13, 'Permission denied')",
      }),
    ];
    const suggestions = evaluateSuggestions(logs);
    const s = suggestions.find((s) => s.id === "bazarr-permission-denied");
    expect(s).toBeDefined();
    expect(s!.action?.label).toBe("Fix media permissions");
    expect(s!.action?.container).toBe("bazarr");
  });
});
