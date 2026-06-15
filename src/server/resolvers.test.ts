import { describe, it, expect } from "vitest";
import { resolvers, checkResolverRelevance } from "./resolvers.js";
import type { LogEntry } from "../server/types.js";

function makeLog(service: string, message: string): Array<{ service: string; message: string }> {
  return [{ service, message }];
}

describe("fix-bazarr-permissions resolver", () => {
  it("is defined with correct metadata", () => {
    const resolver = resolvers.find((r) => r.id === "fix-bazarr-permissions");
    expect(resolver).toBeDefined();
    expect(resolver!.title).toBe("Fix media file permissions");
    expect(resolver!.service).toBe("bazarr");
    expect(resolver!.actionLabel).toBe("Fix Permissions");
  });

  it("has a single host step that runs chown", () => {
    const resolver = resolvers.find((r) => r.id === "fix-bazarr-permissions");
    expect(resolver).toBeDefined();
    expect(resolver!.steps).toHaveLength(1);
    expect(resolver!.steps[0].type).toBe("host");
    expect(resolver!.steps[0].command).toContain("chown");
    expect(resolver!.steps[0].command).toContain("/media");
    expect(resolver!.steps[0].command).toContain("PUID");
    expect(resolver!.steps[0].command).toContain("PGID");
  });

  it("is relevant for bazarr permission error logs", () => {
    const result = checkResolverRelevance(
      "fix-bazarr-permissions",
      makeLog("bazarr", "BAZARR Error saving Subtitles file to disk: PermissionError(13, 'Permission denied')")
    );
    expect(result).toBe(true);
  });

  it("is relevant for bazarr PermissionError", () => {
    const result = checkResolverRelevance(
      "fix-bazarr-permissions",
      makeLog("bazarr", "ERROR (manual:196) - BAZARR PermissionError")
    );
    expect(result).toBe(true);
  });

  it("is NOT relevant for unrelated bazarr messages", () => {
    const result = checkResolverRelevance(
      "fix-bazarr-permissions",
      makeLog("bazarr", "BAZARR Successfully downloaded subtitles")
    );
    expect(result).toBe(false);
  });

  it("is NOT relevant for permission errors in other services", () => {
    const result = checkResolverRelevance(
      "fix-bazarr-permissions",
      makeLog("sonarr", "PermissionError: Cannot write to /config")
    );
    expect(result).toBe(false);
  });

  it("is NOT relevant for non-matching resolver IDs", () => {
    const result = checkResolverRelevance(
      "restart-service",
      makeLog("bazarr", "BAZARR Error saving Subtitles file: PermissionError")
    );
    // restart-service resolver doesn't have relevantLogPatterns for bazarr PermissionError
    // actually it does have some patterns but not for PermissionError in bazarr
    expect(result).toBe(false);
  });
});
