import { describe, it, expect } from "vitest";
import { getRunbookEntry, getRunbookByService } from "./runbook.js";

describe("bazarr-permission-denied runbook entry", () => {
  it("exists and has correct metadata", () => {
    const entry = getRunbookEntry("bazarr-permission-denied");
    expect(entry).toBeDefined();
    expect(entry!.title).toBe("Bazarr Permission Denied Saving Subtitles");
    expect(entry!.service).toBe("bazarr");
    expect(entry!.severity).toBe("error");
    expect(entry!.description).toContain("PUID/PGID");
  });

  it("has symptoms", () => {
    const entry = getRunbookEntry("bazarr-permission-denied");
    expect(entry!.symptoms).toHaveLength(3);
    expect(entry!.symptoms[0]).toContain("PermissionError");
    expect(entry!.symptoms[1]).toContain("Error saving Subtitles");
    expect(entry!.symptoms[2]).toContain(".srt");
  });

  it("has causes", () => {
    const entry = getRunbookEntry("bazarr-permission-denied");
    expect(entry!.causes.length).toBeGreaterThanOrEqual(3);
    expect(entry!.causes[0]).toContain("uid/gid");
  });

  it("has at least 3 steps", () => {
    const entry = getRunbookEntry("bazarr-permission-denied");
    expect(entry!.steps.length).toBeGreaterThanOrEqual(3);
  });

  it("has an action step to fix permissions", () => {
    const entry = getRunbookEntry("bazarr-permission-denied");
    const actionStep = entry!.steps.find((s) => s.action);
    expect(actionStep).toBeDefined();
    expect(actionStep!.action!.label).toBe("Fix media permissions");
    expect(actionStep!.action!.container).toBe("bazarr");
  });

  it("appears in service filter for bazarr", () => {
    const entries = getRunbookByService("bazarr");
    expect(entries.some((e) => e.id === "bazarr-permission-denied")).toBe(true);
  });

  it("appears in all service filter", () => {
    const entries = getRunbookByService("all");
    expect(entries.some((e) => e.id === "bazarr-permission-denied")).toBe(true);
  });

  it("returns undefined for unknown entry", () => {
    expect(getRunbookEntry("nonexistent")).toBeUndefined();
  });
});
