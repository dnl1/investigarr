import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { logSince, logTail, port } from "./config.js";
import { getServiceStatuses, listContainers, restartContainer } from "./docker.js";
import { LogHub } from "./log-hub.js";
import { resolvers, runResolver } from "./resolvers.js";
import { addCustomService, getAllServices, type Settings, getSettings, removeCustomService, updateSettings } from "./settings.js";
import type { LogEntry } from "./types.js";

const app = Fastify({ logger: true });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../web");
const maxLogTail = 5000;
const logHub = new LogHub(getAllServices());

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
  return {
    apiKeys: Object.fromEntries(
      getAllServices()
        .filter((svc) => svc.name !== "jellyfin")
        .map((svc) => [svc.name, s.apiKeys[svc.name] ?? ""])
    ),
    serviceUrls: Object.fromEntries(
      getAllServices()
        .map((svc) => [svc.name, s.serviceUrls[svc.name] ?? ""])
    ),
    customServices: s.customServices
  };
});

app.put("/api/settings", async (request, reply) => {
  const body = request.body as { apiKeys?: Record<string, string>; serviceUrls?: Record<string, string> };
  if (!body || typeof body !== "object") {
    reply.status(400).send({ error: "Invalid body" });
    return;
  }
  const update: Partial<Settings> = {};
  if (body.apiKeys !== undefined) {
    const cleaned: Record<string, string> = {};
    for (const key of Object.keys(body.apiKeys)) {
      const v = body.apiKeys[key]?.trim();
      if (v) cleaned[key] = v;
    }
    update.apiKeys = cleaned;
  }
  if (body.serviceUrls !== undefined) {
    const cleaned: Record<string, string> = {};
    for (const key of Object.keys(body.serviceUrls)) {
      const v = body.serviceUrls[key]?.trim();
      if (v) cleaned[key] = v;
    }
    update.serviceUrls = cleaned;
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
