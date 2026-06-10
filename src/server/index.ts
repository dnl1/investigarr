import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import { logSince, logTail, port, services } from "./config.js";
import { getServiceStatuses, restartContainer, streamContainerLogs } from "./docker.js";
import { shouldIncludeLevel } from "./log-level.js";
import { resolvers, runResolver } from "./resolvers.js";
import { type Settings, getSettings, updateSettings } from "./settings.js";

const app = Fastify({ logger: true });
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const webRoot = path.resolve(__dirname, "../web");

app.get("/api/services", async () => {
  return getServiceStatuses(services);
});

app.post("/api/actions/restart/:container", async (request, reply) => {
  const { container } = request.params as { container: string };
  const known = services.some((s) => s.container === container);
  if (!known) {
    reply.status(400).send({ error: `Unknown container: ${container}` });
    return;
  }
  await restartContainer(container);
  return { success: true, container };
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
      services
        .filter((svc) => svc.name !== "jellyfin")
        .map((svc) => [svc.name, s.apiKeys[svc.name] ?? ""])
    ),
    serviceUrls: Object.fromEntries(
      services
        .map((svc) => [svc.name, s.serviceUrls[svc.name] ?? ""])
    )
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

app.get("/api/config", async () => ({ services, logTail, logSince }));

app.get("/events/logs", async (request, reply) => {
  const query = request.query as { services?: string; levels?: string; q?: string; tail?: string };
  const selectedServices = new Set((query.services ?? services.map((service) => service.name).join(",")).split(",").filter(Boolean));
  const selectedLevels = new Set((query.levels ?? "").split(",").filter(Boolean));
  const search = (query.q ?? "").trim().toLowerCase();
  const tail = Math.min(Number(query.tail ?? logTail), 1000);
  const streamServices = services.filter((service) => selectedServices.has(service.name));

  reply.raw.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  reply.raw.write(`event: ready\ndata: ${JSON.stringify({ services: streamServices.map((service) => service.name) })}\n\n`);

  const statuses = await getServiceStatuses(services);
  const enrichMap = new Map(
    statuses.map((s) => [s.name, { containerId: s.id, image: s.image }])
  );

  const closeHandlers = streamServices.map((service) =>
    streamContainerLogs({
      service,
      tail,
      since: logSince,
      meta: enrichMap.get(service.name) ?? null,
      onEntry: (entry) => {
        if (!shouldIncludeLevel(entry.level, selectedLevels)) return;
        if (search && !`${entry.service} ${entry.message}`.toLowerCase().includes(search)) return;
        reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      },
      onError: (error) => {
        reply.raw.write(
          `event: log\ndata: ${JSON.stringify({
            id: `${service.name}-error-${Date.now()}`,
            service: service.name,
            container: service.container,
            timestamp: new Date().toISOString(),
            level: "error",
            message: `Could not read logs: ${error.message}`,
            meta: null
          })}\n\n`
        );
      }
    })
  );

  const heartbeat = setInterval(() => reply.raw.write(": heartbeat\n\n"), 30_000);

  request.raw.on("close", () => {
    clearInterval(heartbeat);
    for (const close of closeHandlers) close();
  });
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

await app.listen({ host: "0.0.0.0", port });
