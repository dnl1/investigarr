import path from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { logSince, logTail, port } from "./config.js";
import { getServiceStatuses, listContainers, restartContainer } from "./docker.js";
import { LogHub } from "./log-hub.js";
import { resolvers, runResolver } from "./resolvers.js";
import { addCustomService, getAllServices, type Settings, getSettings, removeCustomService, updateSettings } from "./settings.js";
import type { LogEntry } from "./types.js";

const app = Fastify({
  logger: {
    serializers: {
      req(req: { method?: string; url?: string; socket?: { remoteAddress?: string } }) {
        return { method: req.method, url: req.url, remoteAddress: req.socket?.remoteAddress };
      }
    }
  }
});
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../web");
const maxLogTail = 5000;
const logHub = new LogHub(getAllServices());
const authDisabled = process.env.DISABLE_AUTH === "true";
const authUser = process.env.INVESTIGARR_USERNAME || "admin";
const authPassword = process.env.INVESTIGARR_PASSWORD;

if (!authDisabled && !authPassword) {
  throw new Error("INVESTIGARR_PASSWORD is required. Set DISABLE_AUTH=true only for trusted local development.");
}

// Simple in-process rate limiter: max 10 auth failures per IP per minute
const _authFailures = new Map<string, { count: number; resetAt: number }>();
function _isRateLimited(ip: string): boolean {
  const rec = _authFailures.get(ip);
  if (!rec || Date.now() > rec.resetAt) return false;
  return rec.count >= 10;
}
function _recordFailure(ip: string): void {
  const now = Date.now();
  const rec = _authFailures.get(ip);
  if (!rec || now > rec.resetAt) {
    _authFailures.set(ip, { count: 1, resetAt: now + 60_000 });
  } else {
    rec.count++;
  }
}

// HMAC both sides with a random key so comparisons are always 32 bytes — eliminates
// the length oracle from the raw Buffer.from approach.
const _hmacKey = randomBytes(32);
function _hmac(s: string): Buffer {
  return createHmac("sha256", _hmacKey).update(s).digest();
}
const _expectedUser = _hmac(authUser);
const _expectedPassword = _hmac(authPassword ?? "");

app.addHook("onRequest", async (request, reply) => {
  if (authDisabled) return;

  if (_isRateLimited(request.ip)) {
    return reply.status(429).send("Too many failed attempts — try again in a minute");
  }

  const header = request.headers.authorization;
  if (!header?.startsWith("Basic ")) {
    return reply.header("WWW-Authenticate", 'Basic realm="Investigarr"').status(401).send("Authentication required");
  }

  const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const user = separator >= 0 ? decoded.slice(0, separator) : "";
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";

  // Compute both before branching so timing doesn't reveal which field is wrong
  const userOk = timingSafeEqual(_hmac(user), _expectedUser);
  const passOk = timingSafeEqual(_hmac(password), _expectedPassword);
  if (!userOk || !passOk) {
    _recordFailure(request.ip);
    return reply.header("WWW-Authenticate", 'Basic realm="Investigarr"').status(401).send("Authentication required");
  }
});

app.get("/api/services", async () => {
  return getServiceStatuses(getAllServices());
});

app.get("/api/containers", async () => {
  const containers = await listContainers();
  return containers
    .flatMap((container) => container.Names.map((name) => name.replace(/^\//, "")))
    .sort((a, b) => a.localeCompare(b));
});

app.post("/api/services/custom", async (request, reply) => {
  const body = request.body as { name?: string; container?: string } | undefined;
  try {
    const containerName = body?.container?.trim() ?? "";
    const containers = await listContainers();
    const exists = containers.some((container) => container.Names.includes(`/${containerName}`));
    if (!exists) throw new Error(`Container not found: ${containerName}`);
    const service = addCustomService({ name: body?.name ?? "", container: body?.container ?? "" });
    await logHub.setServices(getAllServices());
    return service;
  } catch (err) {
    reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.delete("/api/services/custom/:name", async (request, reply) => {
  const { name } = request.params as { name: string };
  if (!removeCustomService(name)) {
    reply.status(404).send({ error: `Custom service not found: ${name}` });
    return;
  }
  await logHub.setServices(getAllServices());
  return { success: true };
});

app.post("/api/actions/restart/:container", async (request, reply) => {
  const { container } = request.params as { container: string };
  const known = getAllServices().some((s) => s.container === container);
  if (!known) {
    reply.status(400).send({ error: `Unknown container: ${container}` });
    return;
  }
  try {
    await restartContainer(container);
    return { success: true, container };
  } catch (err) {
    reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/actions/resolvers", async () =>
  resolvers.map((r) => ({
    id: r.id,
    title: r.title,
    description: r.description,
    service: r.service,
    steps: r.steps.length,
    relevantLogPatterns: r.relevantLogPatterns?.map((p) => ({
      service: p.service,
      pattern: p.pattern.source,
      flags: p.pattern.flags
    })),
    actionLabel: r.actionLabel,
    selectableService: r.selectableService
  }))
);

app.post("/api/actions/resolve/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const body = request.body as { selectedService?: string } | undefined;
  try {
    return await runResolver(id, body);
  } catch (err) {
    reply.status(400).send({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.get("/api/settings", async () => {
  const s = getSettings();
  const svcs = getAllServices();
  const svcsWithKey = svcs.filter((svc) => svc.name !== "jellyfin");
  return {
    apiKeys: Object.fromEntries(svcsWithKey.map((svc) => [svc.name, ""])),
    apiKeyConfigured: Object.fromEntries(svcsWithKey.map((svc) => [svc.name, Boolean(s.apiKeys[svc.name])])),
    serviceUrls: Object.fromEntries(svcs.map((svc) => [svc.name, s.serviceUrls[svc.name] ?? ""])),
    logPaths: Object.fromEntries(svcs.map((svc) => [svc.name, s.logPaths[svc.name] ?? ""])),
    customServices: s.customServices
  };
});

app.put("/api/settings", async (request, reply) => {
  const body = request.body as { apiKeys?: Record<string, string>; serviceUrls?: Record<string, string>; logPaths?: Record<string, string> };
  if (!body || typeof body !== "object") {
    reply.status(400).send({ error: "Invalid body" });
    return;
  }
  const knownServices = new Set(getAllServices().map((svc) => svc.name));
  const update: Partial<Settings> = {};
  if (body.apiKeys !== undefined) {
    const cleaned: Record<string, string> = { ...getSettings().apiKeys };
    for (const key of Object.keys(body.apiKeys)) {
      if (!knownServices.has(key)) continue;
      const v = body.apiKeys[key]?.trim();
      if (v) cleaned[key] = v;
      else delete cleaned[key];
    }
    update.apiKeys = cleaned;
  }
  if (body.serviceUrls !== undefined) {
    const cleaned: Record<string, string> = {};
    for (const key of Object.keys(body.serviceUrls)) {
      if (!knownServices.has(key)) continue;
      const v = body.serviceUrls[key]?.trim();
      if (v) cleaned[key] = v;
    }
    update.serviceUrls = cleaned;
  }
  if (body.logPaths !== undefined) {
    const cleaned: Record<string, string> = {};
    for (const key of Object.keys(body.logPaths)) {
      if (!knownServices.has(key)) continue;
      const v = body.logPaths[key]?.trim();
      if (v) cleaned[key] = v;
    }
    update.logPaths = cleaned;
  }
  updateSettings(update);
  return { success: true };
});

app.get("/api/config", async () => ({ services: getAllServices(), logTail, logSince }));

app.get("/events/logs", async (request, reply) => {
  const query = request.query as { services?: string; levels?: string; q?: string; tail?: string };
  const allServices = getAllServices();
  const selectedServices = new Set((query.services ?? allServices.map((service) => service.name).join(",")).split(",").filter(Boolean));
  const selectedLevels = new Set((query.levels ?? "").split(",").filter(Boolean));
  const search = (query.q ?? "").trim().toLowerCase();
  const requestedTail = Number(query.tail ?? logTail);
  const tail = Number.isFinite(requestedTail) && requestedTail > 0 ? Math.min(requestedTail, maxLogTail) : logTail;
  const streamServices = allServices.filter((service) => selectedServices.has(service.name));
  const levelsProvided = query.levels !== undefined;

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  reply.raw.write(`event: ready\ndata: ${JSON.stringify({ services: streamServices.map((service) => service.name) })}\n\n`);

  const sendLog = (entry: LogEntry) => {
    reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
  };

  for (const entry of logHub.recent({ services: selectedServices, levels: selectedLevels, levelsProvided, search, limit: tail })) {
    sendLog(entry);
  }

  const unsubscribe = logHub.subscribe((entry) => {
    if (!logHub.matches(entry, { services: selectedServices, levels: selectedLevels, levelsProvided, search })) return;
    sendLog(entry);
  });

  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 30_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
});

app.addHook("onClose", async () => {
  logHub.stop();
});

app.register(fastifyStatic, {
  root: webRoot,
  prefix: "/"
});

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith("/api") || request.raw.url?.startsWith("/events")) {
    reply.status(404).send({ error: "Not found" });
    return;
  }

  reply.sendFile("index.html");
});

await logHub.start();
await app.listen({ host: "0.0.0.0", port });
