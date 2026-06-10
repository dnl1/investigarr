export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal" | "unknown";

export type Service = {
  name: string;
  container: string;
  color: string;
};

export type ContainerSummary = {
  Id: string;
  Names: string[];
  Image: string;
  State: string;
  Status: string;
};

export type ServiceStatus = Service & {
  id: string | null;
  image: string | null;
  state: string;
  status: string | null;
};

export type LogEntryMeta = {
  containerId: string | null;
  image: string | null;
};

export type LogEntry = {
  id: string;
  service: string;
  container: string;
  timestamp: string;
  level: LogLevel;
  message: string;
  meta: LogEntryMeta | null;
};
