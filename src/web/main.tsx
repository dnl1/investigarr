import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { evaluateSuggestions, type Suggestion, type SuggestionAction } from "./rules.js";
import { runbook, getRunbookEntry, type RunbookEntry } from "./runbook.js";
import "./styles.css";

type ServiceName = string;

type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

type ServiceStatus = {
  name: string;
  container: string;
  color: string;
  id: string | null;
  image: string | null;
  state: string;
  status: string | null;
};

type LogEntryMeta = {
  containerId: string | null;
  image: string | null;
};

type LogEntry = {
  id: string;
  service: string;
  container: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  meta: LogEntryMeta | null;
};

type Toast = { id: string; type: "success" | "error" | "info"; message: string };

type PatternDef = { service?: string; pattern: string; flags?: string };
type ResolverInfo = {
  id: string;
  title: string;
  description: string;
  service: string;
  steps: number;
  actionLabel?: string;
  selectableService?: { label: string; default: string; options: Array<{ label: string; value: string }> };
  relevantLogPatterns?: PatternDef[];
};
type ResolverResult = { label: string; status: "ok" | "fail" | "running"; error?: string; output?: string };
type ResolverExecution = { id: string; results: ResolverResult[] };

function resolverStatus(results: ResolverResult[]): "ok" | "fail" | "running" {
  if (results.some((r) => r.status === "fail")) return "fail";
  if (results.some((r) => r.status === "running")) return "running";
  return "ok";
}

const levels: LogLevel[] = ["trace", "debug", "info", "warn", "error", "fatal", "unknown"];
const defaultLevels = new Set<LogLevel>(["info", "warn", "debug", "error", "fatal", "unknown"]);
const defaultTailLimit = 1000;
const tailLimitOptions = [500, 1000, 2000, 5000];

const runbookServices = [...new Set(runbook.map((e) => e.service))].sort();

function App() {
  const [services, setServices] = useState<ServiceStatus[]>([]);
  const [selectedServices, setSelectedServices] = useState<Set<string>>(new Set());
  const [selectedLevels, setSelectedLevels] = useState<Set<LogLevel>>(defaultLevels);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [tailLimit, setTailLimit] = useState(defaultTailLimit);
  const [search, setSearch] = useState("");
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [isPaused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [connected, setConnected] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [runningActions, setRunningActions] = useState<Set<string>>(new Set());
  const [showRunbook, setShowRunbook] = useState(false);
  const [runbookFilter, setRunbookFilter] = useState("all");
  const [runbookEntry, setRunbookEntry] = useState<string | null>(null);
  const [expandedRb, setExpandedRb] = useState<Set<string>>(new Set());
  const entryRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const [showResolve, setShowResolve] = useState(false);
  const [resolvers, setResolvers] = useState<ResolverInfo[]>([]);
  const [executingIds, setExecutingIds] = useState<Set<string>>(new Set());
  const [execResultsMap, setExecResultsMap] = useState<Map<string, ResolverExecution>>(new Map());
  const [resolverSelections, setResolverSelections] = useState<Record<string, string>>({});
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [selectedRestartSvcs, setSelectedRestartSvcs] = useState<Set<string>>(new Set());
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<{ apiKeys: Record<string, string>; serviceUrls: Record<string, string> }>({ apiKeys: {}, serviceUrls: {} });
  const [draftKeys, setDraftKeys] = useState<Record<string, string>>({});
  const [draftUrls, setDraftUrls] = useState<Record<string, string>>({});
  const [savingSettings, setSavingSettings] = useState(false);
  const pausedBuffer = useRef<LogEntry[]>([]);
  const isPausedRef = useRef(false);
  const logTopRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    void fetch("/api/services")
      .then((r) => r.json())
      .then((data: ServiceStatus[]) => {
        setServices(data);
        setSelectedServices(new Set(data.map((s) => s.name)));
      });
    void fetch("/api/actions/resolvers")
      .then((r) => r.json())
      .then((data: ResolverInfo[]) => {
        setResolvers(data);
        setResolverSelections(
          Object.fromEntries(data.filter((r) => r.selectableService).map((r) => [r.id, r.selectableService!.default]))
        );
      });
    void fetch("/api/settings")
      .then((r) => r.json())
      .then((data: { apiKeys: Record<string, string>; serviceUrls: Record<string, string> }) => {
        setSettings({ apiKeys: data.apiKeys, serviceUrls: data.serviceUrls });
        setDraftKeys({ ...data.apiKeys });
        setDraftUrls({ ...data.serviceUrls });
      });
  }, []);

  const selectedServiceKey = useMemo(() => Array.from(selectedServices).sort().join(","), [selectedServices]);
  const selectedLevelKey = useMemo(() => Array.from(selectedLevels).sort().join(","), [selectedLevels]);

  useEffect(() => {
    isPausedRef.current = isPaused;
  }, [isPaused]);

  useEffect(() => {
    setLogs([]);
    setConnected(false);
    pausedBuffer.current = [];
    if (selectedServices.size === 0 || selectedLevels.size === 0 || services.length === 0) return;

    const params = new URLSearchParams({
      services: selectedServiceKey,
      levels: selectedLevelKey,
      q: submittedSearch,
      tail: String(tailLimit)
    });
    const source = new EventSource(`/events/logs?${params.toString()}`);

    source.addEventListener("ready", () => setConnected(true));
    source.addEventListener("log", (event) => {
      const entry = JSON.parse((event as MessageEvent).data) as LogEntry;
      if (isPausedRef.current) {
        pausedBuffer.current = [entry, ...pausedBuffer.current].slice(0, tailLimit);
        return;
      }
      appendLog(entry);
    });
    source.onerror = () => setConnected(false);

    return () => source.close();
  }, [services.length, selectedServices.size, selectedLevels.size, selectedServiceKey, selectedLevelKey, submittedSearch, tailLimit]);

  useEffect(() => {
    if (!isPaused && pausedBuffer.current.length > 0) {
      setLogs((cur) => [...pausedBuffer.current, ...cur].slice(0, tailLimit));
      pausedBuffer.current = [];
    }
  }, [isPaused, tailLimit]);

  useEffect(() => {
    if (autoScroll) logTopRef.current?.scrollIntoView({ block: "start" });
  }, [logs, autoScroll]);

  useEffect(() => {
    if (showRunbook && runbookEntry) {
      setExpandedRb((cur) => new Set(cur).add(runbookEntry));
      setTimeout(() => {
        const el = entryRefs.current.get(runbookEntry);
        el?.scrollIntoView({ block: "center" });
      }, 300);
    }
  }, [showRunbook, runbookEntry]);

  const suggestions = useMemo(() => evaluateSuggestions(logs), [logs]);

  const relevantResolverIds = useMemo(() => {
    const ids = new Set<string>();
    for (const s of suggestions) {
      if (s.resolverId) ids.add(s.resolverId);
    }
    for (const r of resolvers) {
      if (!r.relevantLogPatterns) continue;
      const matches = r.relevantLogPatterns.some((p) => {
        const re = new RegExp(p.pattern, p.flags ?? "");
        return logs.some((log) => {
          if (p.service && log.service !== p.service) return false;
          return re.test(log.message);
        });
      });
      if (matches) ids.add(r.id);
    }
    return ids;
  }, [suggestions, resolvers, logs]);

  const recommendedRestartSvcs = useMemo(() => {
    const svcs = new Set<string>();
    const restartR = resolvers.find((r) => r.id === "restart-service");
    if (!restartR?.relevantLogPatterns || !restartR.selectableService) return svcs;
    for (const rp of restartR.relevantLogPatterns) {
      const re = new RegExp(rp.pattern, rp.flags ?? "");
      for (const log of logs) {
        if (rp.service && log.service !== rp.service) continue;
        if (re.test(log.message)) {
          if (rp.service) svcs.add(rp.service);
          break;
        }
      }
    }
    return svcs;
  }, [resolvers, logs]);

  const sortedResolvers = useMemo(() => {
    return [...resolvers].sort((a, b) => {
      const aRel = relevantResolverIds.has(a.id) ? 0 : 1;
      const bRel = relevantResolverIds.has(b.id) ? 0 : 1;
      return aRel - bRel;
    });
  }, [resolvers, relevantResolverIds]);

  // Auto-select recommended restart services when drawer opens
  const initialRestartSvcs = useMemo(() => {
    return new Set(recommendedRestartSvcs);
  }, [recommendedRestartSvcs]);

  const filteredRunbook = useMemo(() => {
    return runbookFilter === "all"
      ? runbook
      : runbook.filter((e) => e.service === runbookFilter);
  }, [runbookFilter]);

  function appendLog(entry: LogEntry) {
    setLogs((cur) => [entry, ...cur].slice(0, tailLimit));
  }

  function toggleService(name: string) {
    setSelectedServices((cur) => {
      const next = new Set(cur);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleLevel(level: LogLevel) {
    setSelectedLevels((cur) => {
      const next = new Set(cur);
      if (next.has(level)) next.delete(level);
      else next.add(level);
      return next;
    });
  }

  function showAllServices() {
    setSelectedServices(new Set(services.map((s) => s.name)));
  }

  function showNoServices() {
    setSelectedServices(new Set());
  }

  function showAllLevels() {
    setSelectedLevels(new Set(levels));
  }

  function showNoLevels() {
    setSelectedLevels(new Set());
  }

  function showOnlyProblems() {
    setSelectedLevels(new Set(["warn", "error", "fatal"]));
  }

  function downloadLogs() {
    const text = logs
      .map((e) => `${e.timestamp} [${e.service}] ${e.level.toUpperCase()} ${e.message}`)
      .join("\n");
    const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `investigarr-${new Date().toISOString()}.log`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function addToast(type: Toast["type"], message: string) {
    const id = crypto.randomUUID();
    setToasts((cur) => [...cur, { id, type, message }]);
    setTimeout(() => setToasts((cur) => cur.filter((t) => t.id !== id)), 4000);
  }

  async function handleAction(action: SuggestionAction) {
    const key = action.container;
    if (runningActions.has(key)) return;
    setRunningActions((cur) => new Set(cur).add(key));
    try {
      const res = await fetch(`/api/actions/restart/${action.container}`, { method: "POST" });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(body);
      }
      addToast("success", `${action.label} — command sent`);
    } catch (err) {
      addToast("error", `Failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunningActions((cur) => {
        const next = new Set(cur);
        next.delete(key);
        return next;
      });
    }
  }

  function toggleExpand(id: string) {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function openRunbook(entryId?: string) {
    setRunbookEntry(entryId ?? null);
    setShowRunbook(true);
  }

  async function runResolver(id: string, svc?: string) {
    if (executingIds.size > 0) return; // block when anything is running
    const selSvc = svc ?? resolverSelections[id];
    setExecutingIds((cur) => new Set(cur).add(id));
    try {
      const res = await fetch(`/api/actions/resolve/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: selSvc ? JSON.stringify({ selectedService: selSvc }) : undefined
      });
      if (!res.ok) throw new Error(await res.text());
      const data: ResolverExecution = await res.json();
      setExecResultsMap((cur) => new Map(cur).set(id, data));
      const title = resolvers.find((r) => r.id === id)?.title ?? id;
      const failed = data.results.some((r) => r.status === "fail");
      addToast(failed ? "error" : "success", `${failed ? "Failed" : "Done"}: ${svc ? `${svc}` : title}`);
    } catch (err) {
      addToast("error", `${resolvers.find((r) => r.id === id)?.title ?? id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setExecutingIds((cur) => {
        const next = new Set(cur);
        next.delete(id);
        return next;
      });
    }
  }

  async function runSelected() {
    const ids = [...checkedIds];
    if (ids.length === 0) return;
    for (const id of ids) {
      if (id === "restart-service") {
        for (const svc of selectedRestartSvcs) {
          await runResolver(id, svc);
          await new Promise((r) => setTimeout(r, 500));
        }
      } else {
        await runResolver(id);
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  function toggleRbEntry(id: string) {
    setExpandedRb((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderResolverRow(r: ResolverInfo) {
    const isRelevant = relevantResolverIds.has(r.id);
    const isChecked = checkedIds.has(r.id);
    const isRunning = executingIds.has(r.id);
    const execResults = execResultsMap.get(r.id);

    return (
      <div key={r.id} className={`rb-entry ${isRelevant ? "relevant" : ""}`}>
        <div className="rb-entry-head">
          <label className="rs-checkbox-label">
            <input
              type="checkbox"
              className="rs-checkbox"
              checked={isChecked}
              disabled={executingIds.size > 0}
              onChange={(e) => {
                setCheckedIds((cur) => {
                  const next = new Set(cur);
                  if (e.target.checked) next.add(r.id);
                  else next.delete(r.id);
                  return next;
                });
              }}
            />
          </label>
          <div className={`rb-entry-icon ${isRelevant ? "warning" : "info"}`}>{isRelevant ? "!" : "⚡"}</div>
          <div className="rb-entry-info">
            <strong>{r.title}</strong>
            <span className="rb-entry-service">
              {r.service} · {r.steps} step{r.steps !== 1 ? "s" : ""}
              {isRelevant && <span className="rs-recommended">Recommended</span>}
            </span>
          </div>
        </div>
        <div className="rb-entry-body">
          <p className="rb-desc">{r.description}</p>
          {r.selectableService && r.id === "restart-service" ? (
            <div className="rs-service-select">
              {(() => {
                const rec = r.selectableService.options.filter((opt) => recommendedRestartSvcs.has(opt.value));
                const rest = r.selectableService.options.filter((opt) => !recommendedRestartSvcs.has(opt.value));
                return (
                  <>
                    {rec.length > 0 && (
                      <div className="rs-service-group">
                        <div className="rs-service-group-label">Recommended</div>
                        {rec.map((opt) => (
                          <label key={opt.value} className="rs-service-opt">
                            <input
                              type="checkbox"
                              checked={selectedRestartSvcs.has(opt.value)}
                              disabled={executingIds.size > 0}
                              onChange={(e) => setSelectedRestartSvcs((cur) => {
                                const next = new Set(cur);
                                e.target.checked ? next.add(opt.value) : next.delete(opt.value);
                                return next;
                              })}
                            />
                            <span>{opt.label}</span>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="rs-service-group">
                      <div className="rs-service-group-label">{rec.length > 0 ? "All Services" : "Services"}</div>
                      {rest.map((opt) => (
                        <label key={opt.value} className="rs-service-opt">
                          <input
                            type="checkbox"
                            checked={selectedRestartSvcs.has(opt.value)}
                            disabled={executingIds.size > 0}
                            onChange={(e) => setSelectedRestartSvcs((cur) => {
                              const next = new Set(cur);
                              e.target.checked ? next.add(opt.value) : next.delete(opt.value);
                              return next;
                            })}
                          />
                          <span>{opt.label}</span>
                        </label>
                      ))}
                    </div>
                  </>
                );
              })()}
            </div>
          ) : r.selectableService ? (
            <label className="resolver-select">
              <span>{r.selectableService.label}</span>
              <select
                value={resolverSelections[r.id] ?? r.selectableService.default}
                disabled={executingIds.size > 0}
                onChange={(e) =>
                  setResolverSelections((cur) => ({ ...cur, [r.id]: e.target.value }))
                }
              >
                {r.selectableService.options.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </label>
          ) : null}
          <button
            className={`rb-act ${isRelevant ? "relevant" : ""}`}
            disabled={executingIds.size > 0 || (r.id === "restart-service" && selectedRestartSvcs.size === 0)}
            onClick={async () => {
              if (r.id === "restart-service") {
                for (const svc of selectedRestartSvcs) {
                  await runResolver(r.id, svc);
                  await new Promise((r) => setTimeout(r, 500));
                }
              } else {
                runResolver(r.id);
              }
            }}
          >
            {isRunning ? "Running..." : r.actionLabel ?? "Run"}
          </button>
          {execResults && (
            <div className="rs-steps">
              <div className={`rs-summary ${resolverStatus(execResults.results)}`}>
                {resolverStatus(execResults.results) === "ok" && "Completed successfully"}
                {resolverStatus(execResults.results) === "fail" && "Stopped after a failed step"}
                {resolverStatus(execResults.results) === "running" && "Still running"}
              </div>
              {execResults.results.map((step, i) => (
                <div key={i} className={`rs-step ${step.status}`}>
                  <span className="rs-step-icon">
                    {step.status === "running" && "⟳"}
                    {step.status === "ok" && "✓"}
                    {step.status === "fail" && "✕"}
                  </span>
                  <span className="rs-step-label">{step.label}</span>
                  {step.output && <code className="rs-step-out">{step.output}</code>}
                  {step.error && <span className="rs-step-err">{step.error}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <main className="shell">
      {/* Header */}
      <header className="hero">
        <div>
          <h1>Investigarr</h1>
          <p className="sub">Real-time logs for your media stack</p>
        </div>
        <div className="connBadge">
          <span className={`connDot ${connected ? "ok" : "bad"}`} />
          {connected ? `${logs.length} lines` : "Reconnecting"}
        </div>
      </header>

      {/* Toolbar */}
      <div className="toolbar">
        <form
          className="searchForm"
          onSubmit={(e) => {
            e.preventDefault();
            setSubmittedSearch(search);
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter log messages..."
          />
          <button type="submit">Search</button>
          {submittedSearch && <button type="button" onClick={() => { setSearch(""); setSubmittedSearch(""); }}>Clear</button>}
        </form>
        <label className="tailSelect">
          <span>Tail</span>
          <select value={tailLimit} onChange={(e) => setTailLimit(Number(e.target.value))}>
            {tailLimitOptions.map((limit) => (
              <option key={limit} value={limit}>{limit}</option>
            ))}
          </select>
        </label>
        <div className="spacer" />
        <button onClick={() => setPaused((v) => !v)}>{isPaused ? "Resume" : "Pause"}</button>
        <button onClick={() => setAutoScroll((v) => !v)}>
          {autoScroll ? "Auto-scroll on" : "Auto-scroll off"}
        </button>
        <button onClick={() => setLogs([])}>Clear</button>
        <button onClick={downloadLogs}>Export</button>
        <button className="btn-accent" onClick={() => openRunbook()}>
          Runbook
        </button>
        <button className={`btn-accent resolve-btn ${relevantResolverIds.size > 0 ? "relevant" : ""}`} onClick={() => { setSelectedRestartSvcs(initialRestartSvcs); if (initialRestartSvcs.size > 0) setCheckedIds((cur) => new Set(cur).add("restart-service")); setShowResolve(true); }}>
          Resolve
          {relevantResolverIds.size > 0 && (
            <span className="resolve-badge">{relevantResolverIds.size}</span>
          )}
        </button>
        <button className="btn-accent settings-btn" title="API Keys" onClick={() => { setDraftKeys({ ...settings.apiKeys }); setDraftUrls({ ...settings.serviceUrls }); setShowSettings(true); }}>
          ⚙
        </button>
      </div>

      {/* Filters */}
      <div className="filterRow">
        <div className="panel">
          <div className="panelHead">
            <h2>Services</h2>
            <div className="panelActions">
              <button onClick={showAllServices}>All</button>
              <button onClick={showNoServices}>None</button>
            </div>
          </div>
          <div className="chips">
            {services.map((s) => (
              <button
                key={s.name}
                className={`chip ${selectedServices.has(s.name) ? "active" : ""}`}
                style={{ "--accent": s.color } as React.CSSProperties}
                onClick={() => toggleService(s.name)}
              >
                <span className={`chipDot ${s.state === "running" ? "running" : "stopped"}`} />
                {s.name}
              </button>
            ))}
          </div>
        </div>

        <div className="panel">
          <div className="panelHead">
            <h2>Levels</h2>
            <div className="panelActions">
              <button onClick={showAllLevels}>All</button>
              <button onClick={showNoLevels}>None</button>
              <button onClick={showOnlyProblems}>Issues</button>
            </div>
          </div>
          <div className="chips">
            {levels.map((level) => (
              <button
                key={level}
                className={`chip level ${selectedLevels.has(level) ? "active" : ""} ${level}`}
                onClick={() => toggleLevel(level)}
              >
                {level}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Suggestions */}
      {suggestions.length > 0 && (
        <div className="suggestions">
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.id}
              suggestion={s}
              onAction={handleAction}
              onInfo={openRunbook}
              onResolve={s.resolverId ? () => { setSelectedRestartSvcs(initialRestartSvcs); if (initialRestartSvcs.size > 0) setCheckedIds((cur) => new Set(cur).add("restart-service")); setShowResolve(true); } : undefined}
              running={runningActions}
            />
          ))}
        </div>
      )}

      {/* Logs */}
      <section className="logPanel">
        <div className="logHead">
          <span>Timeline</span>
          <span>
            {selectedServices.size === 0 || selectedLevels.size === 0
              ? "no filters selected"
              : isPaused && pausedBuffer.current.length > 0
              ? `${pausedBuffer.current.length} buffered`
              : "live"}
          </span>
        </div>
        <div className="logs">
          <div ref={logTopRef} />
          {logs.map((entry) => {
            const svc = services.find((s) => s.name === entry.service);
            const isExpanded = expanded.has(entry.id);
            return (
              <article className={`logLine ${entry.level}`} key={entry.id}>
                <div className="logLine-row" onClick={() => toggleExpand(entry.id)}>
                  <time>{formatTime(entry.timestamp)}</time>
                  <span
                    className="svc"
                    style={{ "--accent": svc?.color ?? "#6b7084" } as React.CSSProperties}
                  >
                    {entry.service}
                  </span>
                  <span className="lvl">{entry.level}</span>
                  <p>{entry.message}</p>
                  <span className="expander">{isExpanded ? "−" : "+"}</span>
                </div>
                {isExpanded && <LogMeta entry={entry} />}
              </article>
            );
          })}
        </div>
      </section>

      {/* Toasts */}
      <div className="toastContainer">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.type}`}>
            {t.message}
          </div>
        ))}
      </div>

      {/* Settings Drawer */}
      {showSettings && (
        <>
          <div className="rb-overlay open" onClick={() => setShowSettings(false)} />
          <aside className="rb-drawer open">
            <div className="rb-header">
              <div>
                <h2>Service Settings</h2>
                <p className="rb-subtitle">Configure API keys and URLs for each service. URLs are auto-filled for Docker — change them if running services on different hosts.</p>
              </div>
              <button className="rb-close" onClick={() => setShowSettings(false)}>✕</button>
            </div>
            <div className="rb-list">
              {services.map((svc) => (
                <div key={svc.name} className="settings-field">
                  <label>
                    <span className="settings-label">{svc.name}</span>
                    <span className="settings-container">{svc.container}</span>
                  </label>
                  {svc.name !== "jellyfin" && (
                    <div className="settings-input-row" style={{ marginBottom: "0.35rem" }}>
                      <input
                        type="password"
                        className="settings-input"
                        placeholder={draftKeys[svc.name] ? "••••••••" : "No key configured"}
                        value={draftKeys[svc.name] ?? ""}
                        onChange={(e) => setDraftKeys((cur) => ({ ...cur, [svc.name]: e.target.value }))}
                      />
                      {draftKeys[svc.name] && (
                        <button className="settings-clear" onClick={() => setDraftKeys((cur) => { const n = { ...cur }; delete n[svc.name]; return n; })}>✕</button>
                      )}
                    </div>
                  )}
                  <div className="settings-input-row">
                    <input
                      type="text"
                      className="settings-input"
                      placeholder="Auto-detected URL"
                      value={draftUrls[svc.name] ?? ""}
                      onChange={(e) => setDraftUrls((cur) => ({ ...cur, [svc.name]: e.target.value }))}
                    />
                    {draftUrls[svc.name] && (
                      <button className="settings-clear" onClick={() => setDraftUrls((cur) => { const n = { ...cur }; delete n[svc.name]; return n; })}>✕</button>
                    )}
                  </div>
                </div>
              ))}
              <button
                className="settings-save"
                disabled={savingSettings}
                onClick={async () => {
                  setSavingSettings(true);
                  try {
                    const cleanedKeys: Record<string, string> = {};
                    for (const [k, v] of Object.entries(draftKeys)) {
                      if (v.trim()) cleanedKeys[k] = v.trim();
                    }
                    const cleanedUrls: Record<string, string> = {};
                    for (const [k, v] of Object.entries(draftUrls)) {
                      if (v.trim()) cleanedUrls[k] = v.trim();
                    }
                    const res = await fetch("/api/settings", {
                      method: "PUT",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ apiKeys: cleanedKeys, serviceUrls: cleanedUrls })
                    });
                    if (!res.ok) throw new Error(await res.text());
                    setSettings({ apiKeys: cleanedKeys, serviceUrls: cleanedUrls });
                    addToast("success", "Settings saved");
                    setShowSettings(false);
                  } catch (err) {
                    addToast("error", `Failed to save: ${err instanceof Error ? err.message : String(err)}`);
                  } finally {
                    setSavingSettings(false);
                  }
                }}
              >
                {savingSettings ? "Saving..." : "Save Settings"}
              </button>
            </div>
          </aside>
        </>
      )}

      {/* Resolve Drawer */}
      {showResolve && (
        <>
          <div className="rb-overlay open" onClick={() => setShowResolve(false)} />
          <aside className="rb-drawer open">
            <div className="rb-header">
              <div>
                <h2>Resolve</h2>
                <p className="rb-subtitle">Select one or more fixes to run</p>
              </div>
              <button className="rb-close" onClick={() => setShowResolve(false)}>✕</button>
            </div>

            <div className="rs-actions-bar">
              <button
                className="rs-run-selected"
                disabled={checkedIds.size === 0 || executingIds.size > 0}
                onClick={runSelected}
              >
                {executingIds.size > 0 ? `Running (${executingIds.size})...` : `Run Selected (${checkedIds.size})`}
              </button>
              {checkedIds.size > 0 && (
                <button className="rs-clear" onClick={() => setCheckedIds(new Set())}>
                  Clear
                </button>
              )}
            </div>

            <div className="rb-list">
              {(() => {
                const relevant = sortedResolvers.filter((r) => relevantResolverIds.has(r.id));
                const others = sortedResolvers.filter((r) => !relevantResolverIds.has(r.id));
                return (
                  <>
                    {relevant.length > 0 && (
                      <div className="rs-section">
                        <div className="rs-section-header">Recommended</div>
                        {relevant.map(renderResolverRow)}
                      </div>
                    )}
                    {others.length > 0 && (
                      <div className="rs-section">
                        <div className="rs-section-header">All Resolvers</div>
                        {others.map(renderResolverRow)}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </aside>
        </>
      )}

      {/* Runbook Drawer */}
      {showRunbook && (
        <>
          <div className="rb-overlay open" onClick={() => setShowRunbook(false)} />
          <aside className="rb-drawer open">
            <div className="rb-header">
              <div>
                <h2>Runbook</h2>
                <p className="rb-subtitle">Common problems & troubleshooting steps</p>
              </div>
              <button className="rb-close" onClick={() => setShowRunbook(false)}>✕</button>
            </div>

            <div className="rb-filters">
              <button
                className={`rb-filter ${runbookFilter === "all" ? "active" : ""}`}
                onClick={() => setRunbookFilter("all")}
              >
                All
              </button>
              {runbookServices.map((svc) => (
                <button
                  key={svc}
                  className={`rb-filter ${runbookFilter === svc ? "active" : ""}`}
                  onClick={() => setRunbookFilter(svc)}
                >
                  {svc}
                </button>
              ))}
            </div>

            <div className="rb-list">
              {filteredRunbook.map((entry) => (
                <RunbookCard
                  key={entry.id}
                  entry={entry}
                  isExpanded={expandedRb.has(entry.id)}
                  onToggle={() => toggleRbEntry(entry.id)}
                  onAction={handleAction}
                  running={runningActions}
                  refMap={entryRefs}
                />
              ))}
            </div>
          </aside>
        </>
      )}
    </main>
  );
}

/* ─── Sub-components ─── */

function SuggestionCard({
  suggestion,
  onAction,
  onInfo,
  onResolve,
  running
}: {
  suggestion: Suggestion;
  onAction: (a: SuggestionAction) => void;
  onInfo: (ref?: string) => void;
  onResolve?: () => void;
  running: Set<string>;
}) {
  const busy = suggestion.action ? running.has(suggestion.action.container) : false;
  const icon = suggestion.severity === "error" ? "!" : suggestion.severity === "warning" ? "!" : "i";

  return (
    <div className="suggestion">
      <div className={`suggestion-icon ${suggestion.severity}`}>{icon}</div>
      <div className="suggestion-body">
        <strong>{suggestion.title}</strong>
        <span>{suggestion.details}</span>
      </div>
      {suggestion.ref && (
        <button className="suggestion-info" title="View runbook entry" onClick={() => onInfo(suggestion.ref)}>
          ?
        </button>
      )}
      {onResolve && (
        <button className="suggestion-resolve" title="Open Resolve panel" onClick={onResolve}>
          Fix
        </button>
      )}
      {suggestion.action && (
        <button className="suggestion-act" disabled={busy} onClick={() => onAction(suggestion.action!)}>
          {busy ? "..." : suggestion.action.label}
        </button>
      )}
    </div>
  );
}

function LogMeta({ entry }: { entry: LogEntry }) {
  const items: [string, string][] = [];
  if (entry.meta?.containerId) items.push(["Container", entry.meta.containerId.slice(0, 12)]);
  if (entry.meta?.image) items.push(["Image", entry.meta.image]);
  items.push(["Timestamp", entry.timestamp]);

  return (
    <div className="logMeta">
      {items.map(([label, value]) => (
        <div key={label} className="meta-item">
          <span className="meta-label">{label}</span>
          <code>{value}</code>
        </div>
      ))}
    </div>
  );
}

function RunbookCard({
  entry,
  isExpanded,
  onToggle,
  onAction,
  running,
  refMap
}: {
  entry: RunbookEntry;
  isExpanded: boolean;
  onToggle: () => void;
  onAction: (a: SuggestionAction) => void;
  running: Set<string>;
  refMap: React.MutableRefObject<Map<string, HTMLDivElement>>;
}) {
  const icon = entry.severity === "error" ? "!" : entry.severity === "warning" ? "!" : "i";

  return (
    <div className="rb-entry" ref={(el) => el && refMap.current.set(entry.id, el)}>
      <div className="rb-entry-head" onClick={onToggle}>
        <div className={`rb-entry-icon ${entry.severity}`}>{icon}</div>
        <div className="rb-entry-info">
          <strong>{entry.title}</strong>
          <span className="rb-entry-service">{entry.service}</span>
        </div>
        <span className="expander">{isExpanded ? "−" : "+"}</span>
      </div>

      {isExpanded && (
        <div className="rb-entry-body">
          <p className="rb-desc">{entry.description}</p>

          <h4>Symptoms</h4>
          <ul className="rb-list-compact">
            {entry.symptoms.map((s, i) => <li key={i}>{s}</li>)}
          </ul>

          <h4>Common Causes</h4>
          <ul className="rb-list-compact">
            {entry.causes.map((c, i) => <li key={i}>{c}</li>)}
          </ul>

          <h4>Resolution Steps</h4>
          <ol className="rb-steps">
            {entry.steps.map((step, i) => (
              <li key={i}>
                <p>{step.text}</p>
                {step.command && <code className="rb-cmd">{step.command}</code>}
                {step.action && (
                  <button
                    className="rb-act"
                    disabled={running.has(step.action.container)}
                    onClick={() => onAction(step.action!)}
                  >
                    {running.has(step.action.container) ? "..." : step.action.label}
                  </button>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}

function formatTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const now = new Date();
  const isToday =
    date.getDate() === now.getDate() &&
    date.getMonth() === now.getMonth() &&
    date.getFullYear() === now.getFullYear();
  if (isToday) {
    return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  }
  return date.toLocaleString("en-US", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });
}

createRoot(document.getElementById("root")!).render(<App />);
