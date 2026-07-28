"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { buildAgentInstallCommand } from "@/src/shared/install-command";
import {
  adminOnlySettings,
  buildWorkspacePath,
  canonicalWorkspacePath,
  defaultWorkspaceView,
  parseWorkspacePath,
  usernameSlug,
  type ChatTab,
  type NavKey,
  type SettingKey,
  type WorkspaceView,
} from "@/app/workspace-route";

type UiTask = {
  title: string;
  status: string;
  assignees: string[];
  due: string;
};

type UiMessage = {
  id: string | number;
  kind: string;
  name: string;
  handle: string;
  time: string;
  avatar: string;
  color: string;
  text?: string;
  detail?: string;
  thread?: string;
  reactions?: string[];
  task?: UiTask;
  timestamp?: number;
};

type HubProject = {
  id: string;
  name: string;
  slug: string;
};

type HubIdentity = {
  sub: string;
  email: string;
  displayName: string;
  role: "admin" | "member";
};

type HubAgent = {
  id: string;
  name: string;
  status: string;
  model: string;
  thinkingLevel: string;
  hosting: {
    createdBy: string;
    connectionId: string;
    providerId: string;
    connectionOwnerSub: string;
    connectionLabel: string;
    desiredState: "running" | "stopped";
    runtimeState: string;
    lastError: string | null;
  } | null;
};

type LlmProvider = {
  id: string;
  name: string;
  modelSource: "static" | "connection";
  models: Array<{ id: string; name: string }>;
};

type ProviderConnection = {
  id: string;
  userSub: string;
  providerId: string;
  label: string;
  status: string;
};

type OAuthFlow = {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  events: Array<
    | { type: "auth_url"; url: string; instructions?: string }
    | { type: "device_code"; userCode: string; verificationUri: string }
    | { type: "info" | "progress"; message: string }
  >;
  prompt: {
    id: string;
    type: string;
    message: string;
    placeholder?: string;
    options?: Array<{ id: string; label: string }>;
  } | null;
  connection: ProviderConnection | null;
  error: string | null;
};

type ProviderLoginOptions = {
  signal?: AbortSignal;
  portalWindow?: Window | null;
  onFlow?: (flow: OAuthFlow) => void;
};

type HubJob = {
  id: string;
  targetAgentId: string;
  assignedAgentId: string | null;
  status: string;
  branchLeafId: string | null;
};

type HubDispatch = {
  id: string;
  text: string;
  userSub: string;
  status: string;
  selectedLeafId: string | null;
  createdAt: string;
  jobs: HubJob[];
};

type HubEntry = {
  seq: number;
  entry: {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    message?: {
      role?: string;
      content?: string | Array<Record<string, unknown>>;
      provider?: string;
      model?: string;
      stopReason?: string;
      errorMessage?: string;
    };
    customType?: string;
    data?: Record<string, unknown>;
  };
};

const navItems: Array<{ key: NavKey; icon: string; label: string; badge?: boolean }> = [
  { key: "chat", icon: "◫", label: "Chat" },
  { key: "activity", icon: "↗", label: "Activity" },
  { key: "tasks", icon: "✓", label: "Tasks" },
  { key: "members", icon: "♙", label: "Members" },
  { key: "computers", icon: "▣", label: "Computers", badge: true },
];

const settingGroups: Array<{ title: string; items: Array<{ key: SettingKey; label: string }> }> = [
  {
    title: "Personal",
    items: [
      { key: "account", label: "Account" },
      { key: "language", label: "Language & Region" },
      { key: "appearance", label: "Appearance" },
      { key: "notifications", label: "Notifications" },
    ],
  },
  {
    title: "Workspace",
    items: [
      { key: "server-profile", label: "Server Profile" },
      { key: "billing", label: "Plan & Billing" },
      { key: "administration", label: "Administration" },
      { key: "applications", label: "Applications" },
      { key: "mcp", label: "MCP Servers" },
    ],
  },
  {
    title: "About",
    items: [
      { key: "about", label: "About" },
      { key: "documentation", label: "Documentation ↗" },
      { key: "release-notes", label: "Release Notes" },
    ],
  },
];

const baseMessages: UiMessage[] = [
  {
    id: 1,
    kind: "human",
    name: "Edward",
    handle: "@edward",
    time: "9:41 AM",
    avatar: "ED",
    color: "yellow",
    text: "Morning crew — can we get the hub sync protocol into a reviewable state today? I’d like the reconnect path tested before we invite the rest of the team.",
    reactions: ["⚡ 4", "👀 2"],
  },
  {
    id: 2,
    kind: "agent",
    name: "shark",
    handle: "agent · coding",
    time: "9:43 AM",
    avatar: "SH",
    color: "blue",
    text: "I picked up the reconnect path. The client now resumes from its last acknowledged entry sequence and rejects stale lease epochs.",
    detail: "Working in branch agent/shark/reconnect · 12 files indexed",
    reactions: ["🦈 3", "✓ 1"],
  },
  {
    id: 3,
    kind: "task",
    name: "Task created",
    handle: "from shark’s response",
    time: "9:44 AM",
    avatar: "✓",
    color: "pink",
    task: {
      title: "Add failover coverage for lease recovery",
      status: "IN PROGRESS",
      assignees: ["SH", "CI"],
      due: "Today",
    },
  },
  {
    id: 4,
    kind: "agent",
    name: "Cindy",
    handle: "agent · systems",
    time: "10:02 AM",
    avatar: "CI",
    color: "purple",
    text: "I reviewed the JSONL writer. One edge remains: a leader can fail after fsync but before the index transaction. I’m adding startup reconciliation for that window.",
    detail: "2 tool calls · read session-store.ts · edited recovery.test.ts",
    thread: "3 replies · Edward, shark, Cindy",
    reactions: ["💡 2"],
  },
];

const tasks = [
  { title: "Reconnect from durable cursor", owner: "shark", status: "Review", color: "blue" },
  { title: "Reconcile JSONL after failover", owner: "Cindy", status: "In progress", color: "purple" },
  { title: "Draft agent enrollment copy", owner: "Edward", status: "Todo", color: "yellow" },
];

const files = [
  { name: "session-protocol.md", meta: "Markdown · 18 KB", by: "shark", icon: "MD" },
  { name: "hub-architecture.png", meta: "PNG · 1.4 MB", by: "Edward", icon: "PX" },
  { name: "recovery.test.ts", meta: "TypeScript · 24 KB", by: "Cindy", icon: "TS" },
];

function useHubState() {
  const [identity, setIdentity] = useState<HubIdentity | null>(null);
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agents, setAgents] = useState<HubAgent[]>([]);
  const [dispatches, setDispatches] = useState<HubDispatch[]>([]);
  const [entries, setEntries] = useState<HubEntry[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");
  const [llmProviders, setLlmProviders] = useState<LlmProvider[]>([]);
  const [providerConnections, setProviderConnections] = useState<ProviderConnection[]>([]);
  const [hostedAgentsEnabled, setHostedAgentsEnabled] = useState(false);
  const [nousPortalEnabled, setNousPortalEnabled] = useState(false);

  const fetchJson = useCallback(async <Value,>(path: string, init?: RequestInit): Promise<Value> => {
    const response = await fetch(path, {
      ...init,
      headers: { "Content-Type": "application/json", ...init?.headers },
    });
    if (response.status === 401) {
      window.location.assign(`/api/v1/auth/login?returnTo=${encodeURIComponent(window.location.pathname)}`);
      throw new Error("Sign-in required");
    }
    const body = (await response.json()) as Value & { error?: { message?: string } };
    if (!response.ok) throw new Error(body.error?.message ?? `Hub returned HTTP ${response.status}`);
    return body;
  }, []);

  const refreshProject = useCallback(async (selectedProjectId: string) => {
    const [agentsResult, treeResult, dispatchResult] = await Promise.all([
      fetchJson<{ agents: HubAgent[] }>(`/api/v1/projects/${encodeURIComponent(selectedProjectId)}/agents`),
      fetchJson<{ session: { entries: HubEntry[] } }>(
        `/api/v1/projects/${encodeURIComponent(selectedProjectId)}/tree`,
      ),
      fetchJson<{ dispatches: HubDispatch[] }>(
        `/api/v1/projects/${encodeURIComponent(selectedProjectId)}/dispatches`,
      ),
    ]);
    setAgents(agentsResult.agents);
    setEntries(treeResult.session.entries);
    setDispatches(dispatchResult.dispatches);
  }, [fetchJson]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      fetchJson<{ user: HubIdentity }>("/api/v1/me"),
      fetchJson<{ projects: HubProject[] }>("/api/v1/projects"),
      fetchJson<{
        hostedAgentsEnabled: boolean;
        nousPortalEnabled: boolean;
        providers: LlmProvider[];
      }>("/api/v1/llm/providers"),
      fetchJson<{ connections: ProviderConnection[] }>("/api/v1/provider-connections"),
    ])
      .then(([me, projectResult, providerResult, connectionResult]) => {
        if (cancelled) return;
        setIdentity(me.user);
        setProjects(projectResult.projects);
        setProjectId((current) => current ?? projectResult.projects[0]?.id ?? null);
        setHostedAgentsEnabled(providerResult.hostedAgentsEnabled);
        setNousPortalEnabled(providerResult.nousPortalEnabled);
        setLlmProviders(providerResult.providers);
        setProviderConnections(connectionResult.connections);
        setConnection("live");
      })
      .catch(() => {
        if (!cancelled) setConnection("offline");
      });
    return () => {
      cancelled = true;
    };
  }, [fetchJson]);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        void refreshProject(projectId).catch(() => setConnection("offline"));
      }
    });
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/api/v1/events?projectId=${encodeURIComponent(projectId)}`,
    );
    let refreshTimer: number | undefined;
    socket.onopen = () => setConnection("live");
    socket.onmessage = () => {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        void refreshProject(projectId);
      }, 40);
    };
    socket.onclose = () => setConnection("offline");
    return () => {
      cancelled = true;
      window.clearTimeout(refreshTimer);
      socket.close();
    };
  }, [projectId, refreshProject]);

  const messages = useMemo<UiMessage[]>(() => {
    if (!projectId || connection === "offline") return baseMessages;
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));
    const entriesById = new Map(entries.map(({ entry }) => [entry.id, entry]));
    const agentForEntry = (entry: HubEntry["entry"]): HubAgent | undefined => {
      let cursor: HubEntry["entry"] | undefined = entry;
      while (cursor) {
        if (
          cursor.type === "custom" &&
          ["flock.agent_turn", "flock.recovery"].includes(cursor.customType ?? "") &&
          typeof cursor.data?.agentId === "string"
        ) {
          return agentsById.get(cursor.data.agentId);
        }
        cursor = cursor.parentId ? entriesById.get(cursor.parentId) : undefined;
      }
      return undefined;
    };
    const humanMessages: UiMessage[] = dispatches.map((dispatch) => ({
      id: dispatch.id,
      kind: "human",
      name: identity?.displayName ?? "Member",
      handle: `@${dispatch.userSub}`,
      time: formatTime(dispatch.createdAt),
      timestamp: Date.parse(dispatch.createdAt),
      avatar: initials(identity?.displayName ?? "Member"),
      color: "yellow",
      text: dispatch.text,
      reactions: [],
    }));
    const agentMessages: UiMessage[] = entries.flatMap(({ entry }) => {
      if (entry.type !== "message" || entry.message?.role !== "assistant") return [];
      const agent = agentForEntry(entry);
      const text = messageText(entry.message.content);
      if (!text && entry.message.stopReason !== "error") return [];
      return [{
        id: entry.id,
        kind: "agent",
        name: agent?.name ?? "Agent",
        handle: `agent · ${entry.message.provider ?? "pi"}`,
        time: formatTime(entry.timestamp),
        timestamp: Date.parse(entry.timestamp),
        avatar: initials(agent?.name ?? "Agent"),
        color: agentColor(agent?.id ?? entry.id),
        text: text || entry.message.errorMessage || "The model run ended with an error.",
        detail: `${entry.message.model ?? "model"} · ${entry.message.stopReason ?? "complete"}`,
        reactions: [],
      }];
    });
    return [...humanMessages, ...agentMessages].sort(
      (left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0),
    );
  }, [agents, connection, dispatches, entries, identity, projectId]);

  const sendDispatch = useCallback(async (text: string, targetAgentIds: string[]) => {
    if (!projectId) throw new Error("No project is selected");
    await fetchJson(`/api/v1/projects/${encodeURIComponent(projectId)}/dispatches`, {
      method: "POST",
      body: JSON.stringify({ text, targetAgentIds }),
    });
    await refreshProject(projectId);
  }, [fetchJson, projectId, refreshProject]);

  const selectBranch = useCallback(async (dispatchId: string, leafId: string) => {
    await fetchJson(`/api/v1/dispatches/${encodeURIComponent(dispatchId)}/select`, {
      method: "POST",
      body: JSON.stringify({ leafId }),
    });
    if (projectId) await refreshProject(projectId);
  }, [fetchJson, projectId, refreshProject]);

  const createEnrollment = useCallback(async (name: string) => {
    if (!projectId) throw new Error("No project is selected");
    const result = await fetchJson<{ enrollment: { secret: string; expiresAt: string } }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/enrollments`,
      {
        method: "POST",
        body: JSON.stringify({ name }),
      },
    );
    return result.enrollment;
  }, [fetchJson, projectId]);

  const refreshConnections = useCallback(async () => {
    const result = await fetchJson<{ connections: ProviderConnection[] }>("/api/v1/provider-connections");
    setProviderConnections(result.connections);
    return result.connections;
  }, [fetchJson]);

  const connectProvider = useCallback(async (
    providerId: string,
    options: ProviderLoginOptions = {},
  ): Promise<ProviderConnection> => {
    const started = await fetchJson<{ flow: OAuthFlow }>(
      `/api/v1/provider-connections/${encodeURIComponent(providerId)}/login`,
      { method: "POST", body: "{}" },
    );
    let flow = started.flow;
    let handledEvents = 0;
    let handledPrompt = "";
    while (flow.status === "running") {
      options.onFlow?.(flow);
      if (options.signal?.aborted) {
        await fetchJson(`/api/v1/oauth-flows/${encodeURIComponent(flow.id)}`, { method: "DELETE" });
        throw new Error("Provider sign-in was cancelled");
      }
      for (const event of flow.events.slice(handledEvents)) {
        if (event.type === "auth_url") {
          if (options.portalWindow && !options.portalWindow.closed) {
            options.portalWindow.location.assign(event.url);
          } else {
            window.open(event.url, "_blank", "noopener,noreferrer");
          }
        } else if (event.type === "device_code") {
          await navigator.clipboard.writeText(event.userCode).catch(() => undefined);
          if (options.portalWindow && !options.portalWindow.closed) {
            options.portalWindow.location.assign(event.verificationUri);
          } else if (!options.onFlow) {
            window.open(event.verificationUri, "_blank", "noopener,noreferrer");
          }
          if (!options.onFlow) {
            window.alert(`Enter code ${event.userCode} in the provider window. The code was copied.`);
          }
        }
      }
      handledEvents = flow.events.length;
      if (flow.prompt && flow.prompt.id !== handledPrompt) {
        handledPrompt = flow.prompt.id;
        const value = flow.prompt.type === "select"
          ? window.prompt(
              `${flow.prompt.message}\n${flow.prompt.options?.map((option) => `${option.id}: ${option.label}`).join("\n") ?? ""}`,
            )
          : window.prompt(flow.prompt.message, flow.prompt.placeholder ?? "");
        if (value === null) {
          await fetchJson(`/api/v1/oauth-flows/${encodeURIComponent(flow.id)}`, { method: "DELETE" });
          throw new Error("Provider sign-in was cancelled");
        }
        flow = (await fetchJson<{ flow: OAuthFlow }>(
          `/api/v1/oauth-flows/${encodeURIComponent(flow.id)}`,
          { method: "POST", body: JSON.stringify({ promptId: flow.prompt.id, value }) },
        )).flow;
        continue;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 1000));
      flow = (await fetchJson<{ flow: OAuthFlow }>(
        `/api/v1/oauth-flows/${encodeURIComponent(flow.id)}`,
      )).flow;
    }
    options.onFlow?.(flow);
    if (flow.status !== "completed") throw new Error(flow.error ?? "Provider sign-in did not complete");
    const connections = await refreshConnections();
    const connection = flow.connection
      ?? connections.find((candidate) => candidate.providerId === providerId);
    if (!connection) throw new Error("Provider sign-in completed without a connection");
    return connection;
  }, [fetchJson, refreshConnections]);

  const loadConnectionModels = useCallback(async (connectionId: string) => {
    return fetchJson<{ providerId: string; models: Array<{ id: string; name: string }> }>(
      `/api/v1/provider-connections/${encodeURIComponent(connectionId)}/models`,
    );
  }, [fetchJson]);

  const createHostedAgent = useCallback(async (input: {
    name: string;
    connectionId: string;
    model: string;
    thinkingLevel: string;
  }) => {
    if (!projectId) throw new Error("No project is selected");
    await fetchJson(`/api/v1/projects/${encodeURIComponent(projectId)}/hosted-agents`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    await refreshProject(projectId);
  }, [fetchJson, projectId, refreshProject]);

  const updateHostedAgent = useCallback(async (
    agentId: string,
    input: { desiredState?: "running" | "stopped"; connectionId?: string; model?: string; thinkingLevel?: string },
  ) => {
    await fetchJson(`/api/v1/hosted-agents/${encodeURIComponent(agentId)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    if (projectId) await refreshProject(projectId);
  }, [fetchJson, projectId, refreshProject]);

  const deleteHostedAgent = useCallback(async (agentId: string) => {
    await fetchJson(`/api/v1/hosted-agents/${encodeURIComponent(agentId)}`, { method: "DELETE" });
    if (projectId) await refreshProject(projectId);
  }, [fetchJson, projectId, refreshProject]);

  const logout = useCallback(async () => {
    const response = await fetch("/api/v1/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error("Flock could not sign you out");
    window.location.assign("/");
  }, []);

  return {
    identity,
    projects,
    project: projects.find((project) => project.id === projectId) ?? null,
    projectId,
    setProjectId,
    agents,
    dispatches,
    messages,
    connection,
    sendDispatch,
    selectBranch,
    createEnrollment,
    llmProviders,
    providerConnections,
    hostedAgentsEnabled,
    nousPortalEnabled,
    connectProvider,
    loadConnectionModels,
    createHostedAgent,
    updateHostedAgent,
    deleteHostedAgent,
    logout,
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((value) => {
      if (typeof value !== "object" || value === null) return [];
      const block = value as Record<string, unknown>;
      return typeof block.text === "string"
        ? [block.text]
        : typeof block.thinking === "string"
          ? []
          : [];
    })
    .join("\n");
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .map((part) => part[0] ?? "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
}

function agentColor(value: string): string {
  return ["blue", "purple", "green", "pink"][value.split("").reduce((sum, char) => sum + char.charCodeAt(0), 0) % 4]!;
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function PixelAvatar({
  text,
  color = "yellow",
  size = "md",
}: {
  text: string;
  color?: string;
  size?: "sm" | "md" | "lg";
}) {
  return <span className={`pixel-avatar ${color} ${size}`}>{text}</span>;
}

function StatusPill({ children, tone = "neutral" }: { children: React.ReactNode; tone?: string }) {
  return <span className={`status-pill ${tone}`}>{children}</span>;
}

function Switch({ defaultOn = false, label }: { defaultOn?: boolean; label: string }) {
  const [on, setOn] = useState(defaultOn);
  return (
    <button
      type="button"
      className={`switch ${on ? "on" : ""}`}
      aria-label={label}
      aria-pressed={on}
      onClick={() => setOn(!on)}
    >
      <span />
    </button>
  );
}

function GlobalRail({
  active,
  onChange,
  onSearch,
  onServer,
}: {
  active: NavKey;
  onChange: (key: NavKey) => void;
  onSearch: () => void;
  onServer: () => void;
}) {
  return (
    <aside className="global-rail" aria-label="Global navigation">
      <div className="rail-top">
        <button className="server-mark" aria-label="Switch server" onClick={onServer}>
          <img src="/flock.png" alt="" />
          <span className="online-dot" />
        </button>
        <button className="rail-button" aria-label="Search" onClick={onSearch}>
          <span className="rail-icon">⌕</span>
          <span>Search</span>
        </button>
      </div>
      <nav className="rail-nav">
        {navItems.map((item) => (
          <button
            key={item.key}
            className={`rail-button ${active === item.key ? "active" : ""}`}
            onClick={() => onChange(item.key)}
            aria-current={active === item.key ? "page" : undefined}
          >
            <span className="rail-icon">{item.icon}</span>
            <span>{item.label}</span>
            {item.badge && <i className="attention-dot" />}
          </button>
        ))}
      </nav>
      <button
        className={`rail-button rail-settings ${active === "settings" ? "active" : ""}`}
        onClick={() => onChange("settings")}
      >
        <span className="rail-icon">⚙</span>
        <span>Settings</span>
      </button>
    </aside>
  );
}

function Section({
  title,
  children,
  action,
  openDefault = true,
}: {
  title: string;
  children: React.ReactNode;
  action?: string;
  openDefault?: boolean;
}) {
  const [open, setOpen] = useState(openDefault);
  return (
    <section className="conversation-section">
      <div className="section-heading">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
          <span className={`chevron ${open ? "open" : ""}`}>›</span>
          {title}
        </button>
        {action && <button aria-label={`${action} ${title}`}>{action}</button>}
      </div>
      {open && <div className="section-items">{children}</div>}
    </section>
  );
}

function ConversationSidebar({
  current,
  onChannel,
  mobileOpen,
  onClose,
  project,
  agents,
  identity,
}: {
  current: string;
  onChannel: (channel: string) => void;
  mobileOpen: boolean;
  onClose: () => void;
  project: HubProject | null;
  agents: HubAgent[];
  identity: { displayName: string; role: string } | null;
}) {
  return (
    <aside className={`conversation-sidebar ${mobileOpen ? "mobile-open" : ""}`}>
      <div className="workspace-title">
        <div>
          <span className="eyebrow">{project?.name ?? "Flock Works"}</span>
          <strong>Chat</strong>
        </div>
        <button onClick={onClose} aria-label="Close sidebar">×</button>
      </div>
      <button className="sidebar-search">
        <span>⌕</span>
        Jump to…
        <kbd>⌘ K</kbd>
      </button>
      <div className="conversation-scroll">
        <Section title="Saved items">
          <button className="conversation-item"><span>✦</span> Later</button>
        </Section>
        <Section title="Pinned conversations" action="+">
          <button className="conversation-item"><span>▤</span> Hub launch checklist</button>
          <button className="conversation-item"><span>▤</span> Agent protocol notes</button>
        </Section>
        <Section title="Joint Channels" action="+">
          <button className="conversation-item"><span>⊞</span> partner-lab <em>6</em></button>
        </Section>
        <Section title="Channels" action="+">
          {["all", "private-onboarding-owner"].map((channel) => (
            <button
              key={channel}
              onClick={() => onChannel(channel)}
              className={`conversation-item ${current === channel ? "selected" : ""}`}
            >
              <span>{channel.startsWith("private") ? "⌁" : "#"}</span>
              {channel}
              {channel === "all" && <em>3</em>}
            </button>
          ))}
        </Section>
        <Section title="Direct Messages" action="+">
          {(agents.length ? agents : [
            { id: "shark", name: "shark", status: "online", model: "", thinkingLevel: "" },
            { id: "cindy", name: "Cindy", status: "busy", model: "", thinkingLevel: "" },
          ]).map((agent) => (
            <button className="conversation-item" key={agent.id}>
              <PixelAvatar text={initials(agent.name)} color={agentColor(agent.id)} size="sm" />
              {agent.name}
              <i className={`presence ${agent.status === "offline" ? "" : agent.status === "busy" ? "busy" : "online"}`} />
            </button>
          ))}
        </Section>
      </div>
      <div className="current-user">
        <PixelAvatar text={initials(identity?.displayName ?? "Edward")} color="yellow" />
        <div><strong>{identity?.displayName ?? "Edward"}</strong><span>{identity?.role === "admin" ? "Owner" : "Member"} · Online</span></div>
        <button>•••</button>
      </div>
    </aside>
  );
}

function Message({
  message,
  onOpenThread,
}: {
  message: UiMessage;
  onOpenThread?: () => void;
}) {
  if (message.task) {
    return (
      <article className="message-row task-message">
        <PixelAvatar text={message.avatar} color={message.color} />
        <div className="message-body">
          <div className="message-meta"><strong>{message.name}</strong><span>{message.handle}</span><time>{message.time}</time></div>
          <div className="task-card">
            <div className="task-card-top"><StatusPill tone="pink">TASK</StatusPill><span>•••</span></div>
            <h3>{message.task.title}</h3>
            <div className="task-card-bottom">
              <StatusPill tone="blue">{message.task.status}</StatusPill>
              <div className="stacked-avatars">
                {message.task.assignees.map((a, i) => <PixelAvatar key={a} text={a} color={i ? "purple" : "blue"} size="sm" />)}
              </div>
              <span className="task-due">◷ {message.task.due}</span>
            </div>
          </div>
        </div>
      </article>
    );
  }

  return (
    <article className="message-row">
      <PixelAvatar text={message.avatar} color={message.color} />
      <div className="message-body">
        <div className="message-meta">
          <strong>{message.name}</strong>
          {"kind" in message && message.kind === "agent" && <StatusPill tone="agent">AGENT</StatusPill>}
          <span>{message.handle}</span>
          <time>{message.time}</time>
        </div>
        {message.text && <p>{message.text}</p>}
        {message.detail && <div className="agent-detail"><span className="pulse-dot" />{message.detail}</div>}
        {message.thread && <button className="thread-preview" onClick={onOpenThread}><span className="thread-lines">↳</span>{message.thread}<b>→</b></button>}
        {message.reactions && (
          <div className="reactions">{message.reactions.map((reaction) => <button key={reaction}>{reaction}</button>)}<button>＋</button></div>
        )}
      </div>
    </article>
  );
}

function ThreadPane({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState("");

  return (
    <aside className="thread-pane" aria-label="Thread">
      <header className="thread-header">
        <div><strong>Thread</strong><span>— #all</span></div>
        <div>
          <button title="Search thread">⌕</button>
          <button className="view-channel">↗ View in channel</button>
          <button aria-label="Close thread" onClick={onClose}>×</button>
        </div>
      </header>
      <div className="thread-feed">
        <article className="thread-root">
          <PixelAvatar text="ED" color="yellow" />
          <div>
            <div className="message-meta"><strong>Edward</strong><span>@edward</span><time>10:02 AM</time></div>
            <p>@shark can you verify the hub reconnect path before we invite the team?</p>
          </div>
        </article>
        <div className="thread-separator"><span>Beginning of replies</span><b>3 replies</b></div>
        <article className="thread-reply">
          <PixelAvatar text="SH" color="blue" />
          <div>
            <div className="message-meta"><strong>shark</strong><StatusPill tone="agent">AGENT</StatusPill><time>10:04 AM</time></div>
            <p>The cursor resume path is covered. I’m running one final stale-lease case now.</p>
          </div>
        </article>
        <article className="thread-reply">
          <PixelAvatar text="CI" color="purple" />
          <div>
            <div className="message-meta"><strong>Cindy</strong><StatusPill tone="agent">AGENT</StatusPill><time>10:07 AM</time></div>
            <p>I’ll validate the JSONL index reconciliation after that run lands.</p>
          </div>
        </article>
        <div className="thread-event"><span>10:08 AM</span> shark started checking the reconnect branch</div>
      </div>
      <div className="thread-composer">
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Message thread"
          aria-label="Message thread"
        />
        <div>
          <span><button title="Attach media">▧</button><button title="Attach file">＋</button></span>
          <button className="thread-send" disabled={!text.trim()}>↗</button>
        </div>
      </div>
    </aside>
  );
}

function Composer({
  onSend,
  agentName,
}: {
  onSend: (text: string, asTask: boolean) => void;
  agentName: string;
}) {
  const [text, setText] = useState("");
  const [asTask, setAsTask] = useState(false);

  function send() {
    if (!text.trim()) return;
    onSend(text.trim(), asTask);
    setText("");
    setAsTask(false);
  }

  return (
    <div className="composer-wrap">
      <div className={`composer ${asTask ? "task-mode" : ""}`}>
        {asTask && <div className="task-banner"><StatusPill tone="pink">NEW TASK</StatusPill><span>This message will be added to the task board</span></div>}
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              send();
            }
          }}
          placeholder={`Message #all or @${agentName}`}
          aria-label="Message"
        />
        <div className="composer-actions">
          <div>
            <button title="Attach file">＋</button>
            <button title="Add media">▧</button>
            <button title="Mention agent">@</button>
          </div>
          <div>
            <button className={`as-task ${asTask ? "active" : ""}`} onClick={() => setAsTask(!asTask)}>✓ As Task</button>
            <button className="send-button" onClick={send}>Send <span>↵</span></button>
          </div>
        </div>
      </div>
      <p className="composer-hint"><span className="pulse-dot" /> shark and Cindy can see this channel · Shift + Enter for a new line</p>
    </div>
  );
}

function ChannelWorkspace({
  onOpenSidebar,
  tab,
  onTab,
  messages: hubMessages,
  agents,
  dispatches,
  connection,
  onDispatch,
  onSelectBranch,
}: {
  onOpenSidebar: () => void;
  tab: ChatTab;
  onTab: (tab: ChatTab) => void;
  messages: UiMessage[];
  agents: HubAgent[];
  dispatches: HubDispatch[];
  connection: "connecting" | "live" | "offline";
  onDispatch: (text: string, targetAgentIds: string[]) => Promise<void>;
  onSelectBranch: (dispatchId: string, leafId: string) => Promise<void>;
}) {
  const [localMessages, setLocalMessages] = useState<UiMessage[]>([]);
  const [muted, setMuted] = useState(false);
  const [agentMenu, setAgentMenu] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);
  const [threadOpen, setThreadOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setTargets((current) => {
        const valid = current.filter((id) => agents.some((agent) => agent.id === id));
        return valid.length > 0 ? valid : agents.filter((agent) => agent.status !== "revoked").map((agent) => agent.id);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [agents]);

  function send(text: string, asTask: boolean) {
    if (asTask) {
      const next: UiMessage = {
          id: Date.now(),
          kind: "task",
          name: "Task created",
          handle: "from your message",
          time: "now",
          avatar: "✓",
          color: "pink",
          task: { title: text, status: "TODO", assignees: ["ED"], due: "No due date" },
        };
      setLocalMessages((current) => [...current, next]);
      return;
    }
    if (targets.length === 0) {
      setLocalMessages((current) => [...current, {
        id: Date.now(),
        kind: "agent",
        name: "Hub",
        handle: "system",
        time: "now",
        avatar: "!",
        color: "pink",
        text: "Choose at least one enrolled agent before sending.",
      }]);
      return;
    }
    void onDispatch(text, targets).catch((error: unknown) => {
      setLocalMessages((current) => [...current, {
        id: Date.now(),
        kind: "agent",
        name: "Hub",
        handle: "system",
        time: "now",
        avatar: "!",
        color: "pink",
        text: error instanceof Error ? error.message : "The dispatch could not be sent.",
      }]);
    });
  }

  return (
    <div className={`channel-stage ${threadOpen ? "thread-open" : ""}`}>
    <main className="channel-workspace">
      <header className="channel-header">
        <button className="mobile-sidebar-toggle" onClick={onOpenSidebar}>☰</button>
        <div className="channel-identity">
          <div><h1><span>#</span> all</h1><StatusPill tone={connection === "live" ? "green" : "pink"}>{connection.toUpperCase()}</StatusPill></div>
          <p>Company-wide coordination, agent updates, and launch decisions.</p>
        </div>
        <div className="channel-actions">
          <button title="Search channel">⌕</button>
          <button className={muted ? "pink-active" : ""} title="Mute channel" onClick={() => setMuted(!muted)}>{muted ? "◉" : "◌"}</button>
          <button className={agentMenu ? "pink-active" : ""} title="Agents" onClick={() => setAgentMenu(!agentMenu)}>⌘</button>
          <button title="Channel settings">•••</button>
          <button className="member-count"><span className="mini-stack"><i>YOU</i><i>AI</i></span>{agents.length + 1}</button>
        </div>
        {agentMenu && (
          <div className="agent-popover">
            <span className="eyebrow">DISPATCH TO</span>
            {agents.map((agent) => (
              <button
                type="button"
                className="agent-target"
                key={agent.id}
                onClick={() => setTargets((current) =>
                  current.includes(agent.id)
                    ? current.filter((id) => id !== agent.id)
                    : [...current, agent.id],
                )}
              >
                <PixelAvatar text={initials(agent.name)} color={agentColor(agent.id)} size="sm" />
                <p><strong>{agent.name}</strong><small>{agent.model} · {agent.status}</small></p>
                <b>{targets.includes(agent.id) ? "✓" : "○"}</b>
              </button>
            ))}
            {agents.length === 0 && <p className="agent-empty">Enroll an agent to dispatch work.</p>}
          </div>
        )}
      </header>
      <nav className="content-tabs" aria-label="Channel content">
        {(["chat", "tasks", "files"] as ChatTab[]).map((key) => (
          <button key={key} className={tab === key ? "active" : ""} onClick={() => onTab(key)}>
            {key[0].toUpperCase() + key.slice(1)}
            {key === "tasks" && <em>3</em>}
          </button>
        ))}
      </nav>
      {tab === "chat" && (
        <>
          <div className="message-feed">
            <div className="message-start">Beginning of messages</div>
            <div className="date-separator"><span>MONDAY, JULY 27</span></div>
            <div className="system-event"><span>✦</span><p><strong>Cindy joined #all</strong> via the owner onboarding flow.</p><time>9:32 AM</time></div>
            {[...hubMessages, ...localMessages].map((message) => <Message key={message.id} message={message} onOpenThread={() => setThreadOpen(true)} />)}
            {dispatches.filter((dispatch) => dispatch.status === "awaiting_selection").map((dispatch) => (
              <article className="branch-selector" key={dispatch.id}>
                <div><StatusPill tone="pink">CHOOSE BRANCH</StatusPill><h3>{dispatch.text}</h3></div>
                <div>
                  {dispatch.jobs.filter((job) => job.status === "completed" && job.branchLeafId).map((job) => {
                    const agent = agents.find((candidate) => candidate.id === (job.assignedAgentId ?? job.targetAgentId));
                    return (
                      <button key={job.id} onClick={() => void onSelectBranch(dispatch.id, job.branchLeafId!)}>
                        <PixelAvatar text={initials(agent?.name ?? "AI")} color={agentColor(agent?.id ?? job.id)} size="sm" />
                        Use {agent?.name ?? "agent"}’s branch <span>→</span>
                      </button>
                    );
                  })}
                </div>
              </article>
            ))}
            {agents.some((agent) => agent.status === "busy") && (
              <div className="agent-typing"><PixelAvatar text="AI" color="blue" size="sm" /><span><i /><i /><i /></span><p>An agent is working</p></div>
            )}
          </div>
          <Composer onSend={send} agentName="shark" />
        </>
      )}
      {tab === "tasks" && (
        <div className="tab-page">
          <div className="tab-page-heading"><div><span className="eyebrow">CHANNEL TASKS</span><h2>Work in motion</h2></div><button className="black-button">＋ New task</button></div>
          <div className="task-list">
            {tasks.map((task) => (
              <article key={task.title}>
                <span className={`task-check ${task.color}`} />
                <div><h3>{task.title}</h3><p>Assigned to <strong>{task.owner}</strong></p></div>
                <StatusPill tone={task.color}>{task.status}</StatusPill>
                <button>•••</button>
              </article>
            ))}
          </div>
        </div>
      )}
      {tab === "files" && (
        <div className="tab-page">
          <div className="tab-page-heading"><div><span className="eyebrow">SHARED FILES</span><h2>Recently added</h2></div><button className="black-button">↑ Upload</button></div>
          <div className="file-grid">
            {files.map((file) => (
              <article key={file.name}>
                <span className="file-icon">{file.icon}</span>
                <div><h3>{file.name}</h3><p>{file.meta}</p><small>Added by {file.by}</small></div>
                <button>•••</button>
              </article>
            ))}
          </div>
        </div>
      )}
    </main>
    {threadOpen && <ThreadPane onClose={() => setThreadOpen(false)} />}
    </div>
  );
}

function FieldRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field-row">
      <div><label>{label}</label>{description && <p>{description}</p>}</div>
      <div className="field-control">{children}</div>
    </div>
  );
}

function TextField({ value, readOnly = false }: { value: string; readOnly?: boolean }) {
  return <input defaultValue={value} readOnly={readOnly} />;
}

function SelectField({ value, children }: { value: string; children?: React.ReactNode }) {
  return <select defaultValue={value}>{children ?? <option>{value}</option>}</select>;
}

function SettingsHeader({
  title,
  kicker,
  summary,
}: {
  title: string;
  kicker: string;
  summary: string;
}) {
  return (
    <div className="settings-content-header">
      <span className="eyebrow">{kicker}</span>
      <h1>{title}</h1>
      <p>{summary}</p>
    </div>
  );
}

function SettingsContent({
  page,
  identity,
  onToast,
  onLogout,
}: {
  page: SettingKey;
  identity: HubIdentity | null;
  onToast: (message: string) => void;
  onLogout: () => Promise<void>;
}) {
  const pageTitle = settingGroups.flatMap((group) => group.items).find((item) => item.key === page)?.label.replace(" ↗", "") ?? "";

  if (page === "account") {
    const displayName = identity?.displayName ?? "Flock member";
    const email = identity?.email ?? "Connecting…";
    const role = identity?.role ?? "member";
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="PERSONAL SETTINGS" summary="Your Google identity and current Flock access." />
        <section className="settings-card profile-card">
          <PixelAvatar text={initials(displayName)} color="yellow" size="lg" />
          <div><h2>{displayName}</h2><p>{role === "admin" ? "Administrator" : "Member"}</p></div>
          <StatusPill tone={role === "admin" ? "yellow" : "neutral"}>{role.toUpperCase()}</StatusPill>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Display name" description="Provided by your Google profile."><TextField value={displayName} readOnly /></FieldRow>
          <FieldRow label="Email" description="Verified by Google when you signed in."><div className="verified-input"><TextField value={email} readOnly /><StatusPill tone="green">VERIFIED</StatusPill></div></FieldRow>
        </section>
        <section className="settings-card">
          <div className="card-heading"><div><h2>Connected account</h2><p>Use this provider to sign in.</p></div></div>
          <div className="connection-row"><span className="provider-logo">G</span><div><strong>Google</strong><p>{email}</p></div><StatusPill tone="green">CONNECTED</StatusPill></div>
        </section>
        <button
          className="logout-button"
          onClick={() => void onLogout().catch((error: unknown) => onToast(error instanceof Error ? error.message : "Could not log out"))}
        >
          Log out
        </button>
      </>
    );
  }

  if (page === "language") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="PERSONAL SETTINGS" summary="Choose how dates, times, and translated messages appear." />
        <section className="settings-card form-card">
          <FieldRow label="Display language" description="The language used across the Flock interface."><SelectField value="English (US)"><option>English (US)</option><option>Deutsch</option><option>日本語</option></SelectField></FieldRow>
          <FieldRow label="Message translation" description="Translate messages that differ from your display language."><SelectField value="Show original with translation"><option>Show original with translation</option><option>Translate automatically</option><option>Never translate</option></SelectField></FieldRow>
          <FieldRow label="Timezone" description="Used for messages, tasks, and reminders."><SelectField value="America/Los_Angeles"><option>America/Los_Angeles</option><option>America/New_York</option><option>Europe/London</option></SelectField></FieldRow>
          <FieldRow label="Time format" description="Choose how times are displayed."><div className="segmented"><button className="active">12 hour</button><button>24 hour</button></div></FieldRow>
        </section>
      </>
    );
  }

  if (page === "appearance") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="PERSONAL SETTINGS" summary="Tune message density and how active agents show their work." />
        <section className="settings-card">
          <FieldRow label="Message font size" description="Adjust conversation text without changing navigation."><div className="range-wrap"><input type="range" min="13" max="19" defaultValue="15" /><b>15px</b></div></FieldRow>
          <div className="message-preview"><PixelAvatar text="CI" color="purple" /><div><strong>Cindy <small>10:02 AM</small></strong><p>I’ll keep the session mirror in sync while you review.</p></div></div>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Live-agent activity" description="Show what an agent is doing while it works."><Switch defaultOn label="Live-agent activity" /></FieldRow>
          <FieldRow label="Compact metadata" description="Use monospaced status labels beneath agent messages."><Switch defaultOn label="Compact metadata" /></FieldRow>
          <FieldRow label="Reduce motion" description="Limit typing and presence animations."><Switch label="Reduce motion" /></FieldRow>
        </section>
      </>
    );
  }

  if (page === "notifications") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="PERSONAL SETTINGS" summary="Control push notifications and quiet individual servers." />
        <section className="settings-card push-card">
          <div className="push-icon">◉</div><div><StatusPill tone="green">ENABLED</StatusPill><h2>Push notifications are active</h2><p>This browser can receive mentions, task assignments, and agent completions.</p></div>
          <button className="outline-button" onClick={() => onToast("Test notification sent")}>Send test push</button>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Mentions and replies"><SelectField value="Immediately" /></FieldRow>
          <FieldRow label="Task assignments"><Switch defaultOn label="Task assignments" /></FieldRow>
          <FieldRow label="Agent completions"><Switch defaultOn label="Agent completions" /></FieldRow>
          <FieldRow label="Mute Flock Works" description="Pause all non-critical alerts from this server."><Switch label="Mute Flock Works" /></FieldRow>
        </section>
        <button className="danger-outline">Disable push notifications</button>
      </>
    );
  }

  if (page === "server-profile") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="WORKSPACE SETTINGS" summary="Update the public identity of this Flock server." />
        <section className="settings-card profile-card server-card">
          <span className="server-image"><img src="/flock.png" alt="" /></span><div><h2>Flock Works</h2><p>18 members · 4 agents</p></div><button className="outline-button">Upload image</button>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Server name"><TextField value="Flock Works" /></FieldRow>
          <FieldRow label="Server slug" description="raft.app/"><div className="input-prefix wide"><span>raft.app/</span><TextField value="flock-works" /></div></FieldRow>
          <div className="form-actions"><button className="black-button" onClick={() => onToast("Server profile saved")}>Save server</button></div>
        </section>
        <section className="settings-card danger-zone"><div><span className="eyebrow">DANGER ZONE</span><h2>Delete this server</h2><p>Permanently remove every channel, message, task, agent enrollment, and file.</p></div><button>Delete Server</button></section>
      </>
    );
  }

  if (page === "billing") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="WORKSPACE SETTINGS" summary="Review your current plan, usage, and next invoice." />
        <section className="plan-hero">
          <div><StatusPill tone="pink">CURRENT PLAN</StatusPill><h2>Studio</h2><p>Built for collaborative teams working with always-on agents.</p></div>
          <div className="plan-price"><strong>$96</strong><span>/ month</span><button className="black-button">Upgrade plan</button></div>
        </section>
        <section className="metric-grid">
          <div><span>MEMBERS</span><strong>18 / 25</strong><progress value="18" max="25" /></div>
          <div><span>AGENT HOURS</span><strong>142 / 250</strong><progress value="142" max="250" /></div>
          <div><span>STORAGE</span><strong>38 / 100 GB</strong><progress value="38" max="100" /></div>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Billing interval"><div className="segmented"><button className="active">Monthly</button><button>Annual −20%</button></div></FieldRow>
          <FieldRow label="Paid seats"><div className="stepper"><button>−</button><strong>18</strong><button>＋</button></div></FieldRow>
          <FieldRow label="Pricing summary"><div className="price-summary"><span>18 seats × $5</span><strong>$90</strong><span>Agent add-on</span><strong>$6</strong></div></FieldRow>
        </section>
      </>
    );
  }

  if (page === "administration") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="WORKSPACE SETTINGS" summary="Set server-wide permissions, onboarding, and member access." />
        <section className="settings-card">
          <div className="card-heading"><div><h2>Owners & administrators</h2><p>People who can manage this workspace.</p></div><button className="outline-button">＋ Add admin</button></div>
          <div className="admin-row"><PixelAvatar text="ED" color="yellow" /><div><strong>Edward</strong><p>edward@raft.works</p></div><StatusPill tone="pink">OWNER</StatusPill><button>•••</button></div>
          <div className="admin-row"><PixelAvatar text="MA" color="green" /><div><strong>Mara Bell</strong><p>mara@raft.works</p></div><StatusPill tone="blue">ADMIN</StatusPill><button>•••</button></div>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="System channel visibility" description="Let members hide #all from their sidebar."><Switch label="System channel visibility" /></FieldRow>
          <FieldRow label="Member directory" description="Allow members to browse the complete member list."><Switch defaultOn label="Member directory" /></FieldRow>
          <FieldRow label="Message translation"><Switch defaultOn label="Message translation" /></FieldRow>
          <FieldRow label="Agent greetings" description="Agents can introduce themselves when enrolled."><Switch defaultOn label="Agent greetings" /></FieldRow>
        </section>
        <section className="settings-card">
          <div className="card-heading"><div><h2>Invites & onboarding</h2><p>3 pending invites · 1 active link</p></div><button className="black-button">Create invite link</button></div>
          <FieldRow label="Pre-join agreement"><button className="outline-button">Edit agreement</button></FieldRow>
          <FieldRow label="Onboarding agent"><SelectField value="Cindy" /></FieldRow>
        </section>
      </>
    );
  }

  if (page === "applications") {
    const apps = [
      { name: "GitHub", copy: "Pull requests, issues, and deployments", badge: "INSTALLED", icon: "GH", color: "dark" },
      { name: "Linear", copy: "Issues and project updates in channels", badge: "MARKETPLACE", icon: "LI", color: "purple" },
      { name: "Figma", copy: "Rich previews and comment activity", badge: "MARKETPLACE", icon: "FI", color: "pink" },
      { name: "Buildkite", copy: "Build status and agent workflows", badge: "MY APP", icon: "BK", color: "green" },
    ];
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="WORKSPACE SETTINGS" summary="Connect services or register an application for your team." />
        <div className="app-toolbar"><div className="app-tabs"><button className="active">Marketplace</button><button>Installed <em>1</em></button><button>My Apps <em>1</em></button></div><button className="black-button">＋ Register app</button></div>
        <div className="market-search"><input placeholder="Search applications…" /><SelectField value="All categories" /><div className="layout-toggle"><button className="active">▦</button><button>☷</button></div></div>
        <div className="app-grid">
          {apps.map((app) => <article key={app.name}><span className={`app-icon ${app.color}`}>{app.icon}</span><StatusPill tone={app.badge === "INSTALLED" ? "green" : "neutral"}>{app.badge}</StatusPill><h2>{app.name}</h2><p>{app.copy}</p><button className="outline-button">{app.badge === "INSTALLED" ? "Configure" : "View app"}</button></article>)}
        </div>
      </>
    );
  }

  if (page === "mcp") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="WORKSPACE SETTINGS" summary="Give agents approved access to tools and knowledge through MCP." />
        <section className="settings-card">
          <div className="card-heading"><div><h2>Managed servers</h2><p>Connections available to enrolled workspace agents.</p></div><button className="black-button">＋ Add Server</button></div>
          <div className="mcp-row"><span className="app-icon dark">GH</span><div><strong>GitHub MCP</strong><p>12 tools · Used by 3 agents</p></div><StatusPill tone="green">CONNECTED</StatusPill><button>Manage</button></div>
        </section>
        <h2 className="section-title">Recommended integrations</h2>
        <div className="recommend-grid">
          <article><span className="app-icon dark">N</span><div><h3>Notion</h3><p>Search team knowledge and update project pages.</p></div><button className="outline-button">Add Server</button></article>
          <article><span className="app-icon purple">LI</span><div><h3>Linear</h3><p>Read, create, and triage product issues.</p></div><button className="outline-button">Add Server</button></article>
          <article><span className="app-icon blue">PG</span><div><h3>Postgres</h3><p>Run scoped queries against approved databases.</p></div><button className="outline-button">Add Server</button></article>
        </div>
      </>
    );
  }

  if (page === "about") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="ABOUT" summary="Product information and the identity of your current workspace." />
        <section className="about-hero"><span className="about-logo"><img src="/flock.png" alt="" /></span><div><h2>Flock</h2><p>A shared place for people and long-running agents to work together.</p><StatusPill tone="neutral">DESKTOP WEB · V0.9.4</StatusPill></div></section>
        <section className="settings-card form-card">
          <FieldRow label="Current workspace"><strong>Flock Works</strong></FieldRow>
          <FieldRow label="Workspace ID"><code>srv_raft_01J8W3YQ</code></FieldRow>
          <FieldRow label="Region"><span>US West · Los Angeles</span></FieldRow>
          <FieldRow label="Session backend"><span>Pi JSONL v3</span></FieldRow>
        </section>
      </>
    );
  }

  if (page === "documentation") {
    return (
      <>
        <SettingsHeader title={pageTitle} kicker="ABOUT" summary="Guides for members, administrators, and agent developers." />
        <section className="docs-card">
          <span>↗</span><div><h2>Read the Flock documentation</h2><p>Set up a server, enroll your first agent, manage session trees, and learn the hub protocol.</p><button className="black-button">Open documentation ↗</button></div>
        </section>
        <div className="docs-links"><button>Getting started <span>→</span></button><button>Agent protocol <span>→</span></button><button>Administration <span>→</span></button></div>
      </>
    );
  }

  return (
    <>
      <SettingsHeader title={pageTitle} kicker="ABOUT" summary="What’s new across collaboration, agents, and administration." />
      <div className="release-list">
        <section><div className="release-version"><StatusPill tone="pink">LATEST</StatusPill><h2>0.9.4</h2><time>July 24, 2026</time></div><div className="release-notes"><p><b className="new">NEW</b> Multi-agent branch comparison in channel chat.</p><p><b className="improved">IMPROVED</b> Faster session-mirror recovery after reconnect.</p><p><b className="fix">FIX</b> Tool status no longer lingers after cancellation.</p></div></section>
        <section><div className="release-version"><h2>0.9.3</h2><time>July 10, 2026</time></div><div className="release-notes"><p><b className="new">NEW</b> Managed MCP connections for workspace owners.</p><p><b className="improved">IMPROVED</b> Denser task cards in conversation history.</p></div></section>
        <section><div className="release-version"><h2>0.9.2</h2><time>June 27, 2026</time></div><div className="release-notes"><p><b className="fix">FIX</b> Correct timezone rendering in translated threads.</p></div></section>
      </div>
    </>
  );
}

function SettingsWorkspace({
  setting,
  onSetting,
  onToast,
  identity,
  onLogout,
}: {
  setting: SettingKey;
  onSetting: (key: SettingKey) => void;
  onToast: (message: string) => void;
  identity: HubIdentity | null;
  onLogout: () => Promise<void>;
}) {
  return (
    <div className="settings-shell">
      <aside className="settings-menu">
        <div className="settings-menu-header"><span className="eyebrow">FLOCK WORKS</span><h1>Settings</h1></div>
        <div className="settings-menu-scroll">
          {settingGroups.map((group) => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.items
                .filter((item) => identity?.role === "admin" || !adminOnlySettings.has(item.key))
                .map((item) => (
                  <button key={item.key} className={setting === item.key ? "active" : ""} onClick={() => onSetting(item.key)}>
                    <span>{item.label}</span>{setting === item.key && <b>→</b>}
                  </button>
                ))}
            </section>
          ))}
        </div>
        <div className="owner-view">
          <PixelAvatar text={initials(identity?.displayName ?? "Member")} color="yellow" size="sm" />
          <div><strong>{identity?.role === "admin" ? "Admin view" : "Member view"}</strong><span>{identity?.email ?? "Connecting…"}</span></div>
        </div>
      </aside>
      <main className="settings-content">
        <div className="settings-content-inner">
          <SettingsContent page={setting} identity={identity} onToast={onToast} onLogout={onLogout} />
        </div>
      </main>
    </div>
  );
}

function UtilityPage({
  active,
  agents = [],
  onCreateEnrollment,
  hostedAgentsEnabled = false,
  nousPortalEnabled = false,
  providers = [],
  providerConnections = [],
  onConnectProvider,
  onLoadConnectionModels,
  onCreateHostedAgent,
  onUpdateHostedAgent,
  onDeleteHostedAgent,
  isAdmin = false,
}: {
  active: Exclude<NavKey, "chat" | "settings">;
  agents?: HubAgent[];
  onCreateEnrollment?: (name: string) => Promise<{ secret: string; expiresAt: string }>;
  hostedAgentsEnabled?: boolean;
  nousPortalEnabled?: boolean;
  providers?: LlmProvider[];
  providerConnections?: ProviderConnection[];
  onConnectProvider?: (
    providerId: string,
    options?: ProviderLoginOptions,
  ) => Promise<ProviderConnection>;
  onLoadConnectionModels?: (
    connectionId: string,
  ) => Promise<{ providerId: string; models: Array<{ id: string; name: string }> }>;
  onCreateHostedAgent?: (input: {
    name: string;
    connectionId: string;
    model: string;
    thinkingLevel: string;
  }) => Promise<void>;
  onUpdateHostedAgent?: (
    agentId: string,
    input: {
      desiredState?: "running" | "stopped";
      connectionId?: string;
      model?: string;
      thinkingLevel?: string;
    },
  ) => Promise<void>;
  onDeleteHostedAgent?: (agentId: string) => Promise<void>;
  isAdmin?: boolean;
}) {
  const [agentName, setAgentName] = useState("");
  const [enrollment, setEnrollment] = useState<{ secret: string; expiresAt: string } | null>(null);
  const [enrollmentError, setEnrollmentError] = useState("");
  const [cloudName, setCloudName] = useState("");
  const [cloudConnectionId, setCloudConnectionId] = useState("");
  const [cloudModel, setCloudModel] = useState("");
  const [cloudThinking, setCloudThinking] = useState("medium");
  const [cloudConsent, setCloudConsent] = useState(false);
  const [cloudBusy, setCloudBusy] = useState(false);
  const [cloudError, setCloudError] = useState("");
  const [nousStage, setNousStage] = useState<"idle" | "auth" | "configure" | "installing">("idle");
  const [nousFlow, setNousFlow] = useState<OAuthFlow | null>(null);
  const [nousAbort, setNousAbort] = useState<AbortController | null>(null);
  const [nousConnectionId, setNousConnectionId] = useState("");
  const [nousModels, setNousModels] = useState<Array<{ id: string; name: string }>>([]);
  const [nousModel, setNousModel] = useState("");
  const [nousSearch, setNousSearch] = useState("");
  const [nousName, setNousName] = useState("");
  const [nousError, setNousError] = useState("");
  const [nousEditingAgent, setNousEditingAgent] = useState<HubAgent | null>(null);
  const advancedConnections = providerConnections.filter(
    (connection) => connection.providerId !== "nous",
  );
  const effectiveConnectionId = cloudConnectionId || advancedConnections[0]?.id || "";
  const selectedConnection = advancedConnections.find((item) => item.id === effectiveConnectionId);
  const selectedProvider = providers.find((provider) => provider.id === selectedConnection?.providerId);
  const effectiveModel = selectedProvider?.models.some(
    (model) => `${selectedProvider.id}/${model.id}` === cloudModel,
  )
    ? cloudModel
    : selectedProvider?.models[0]
      ? `${selectedProvider.id}/${selectedProvider.models[0].id}`
      : "";
  const nousDevice = [...(nousFlow?.events ?? [])].reverse().find(
    (event) => event.type === "device_code",
  );
  const filteredNousModels = nousModels.filter((model) => {
    const query = nousSearch.trim().toLowerCase();
    return !query || model.id.toLowerCase().includes(query) || model.name.toLowerCase().includes(query);
  });
  const visibleNousModel = filteredNousModels.some((model) => model.id === nousModel)
    ? nousModel
    : "";

  async function beginNousFlow(
    editingAgent: HubAgent | null = null,
    forceReconnect = false,
  ) {
    if (!onConnectProvider || !onLoadConnectionModels) return;
    setNousError("");
    setCloudError("");
    setNousEditingAgent(editingAgent);
    setNousName(editingAgent?.name ?? "");
    setNousSearch("");
    setNousModels([]);
    setNousModel("");
    let connection = forceReconnect
      ? undefined
      : providerConnections.find(
          (candidate) => candidate.providerId === "nous" && candidate.status === "connected",
        );
    try {
      if (!connection) {
        setNousStage("auth");
        const controller = new AbortController();
        setNousAbort(controller);
        const portalWindow = window.open("about:blank", "flock-nous-portal");
        if (portalWindow) portalWindow.opener = null;
        connection = await onConnectProvider("nous", {
          signal: controller.signal,
          portalWindow,
          onFlow: setNousFlow,
        });
      }
      setNousConnectionId(connection.id);
      const catalog = await onLoadConnectionModels(connection.id);
      const currentModel = editingAgent?.model.startsWith("nous/")
        ? editingAgent.model.slice("nous/".length)
        : "";
      setNousModels(catalog.models);
      setNousModel(
        catalog.models.some((model) => model.id === currentModel)
          ? currentModel
          : catalog.models[0]?.id ?? "",
      );
      setNousFlow(null);
      setNousAbort(null);
      setNousStage("configure");
    } catch (error) {
      setNousAbort(null);
      setNousStage("idle");
      setNousError(error instanceof Error ? error.message : "Nous Portal setup failed");
    }
  }

  async function submitNousAgent() {
    if (!nousConnectionId || !nousModel) return;
    if (!nousEditingAgent && !nousName.trim()) {
      setNousError("Enter an agent name.");
      return;
    }
    setNousStage("installing");
    setNousError("");
    try {
      if (nousEditingAgent) {
        await onUpdateHostedAgent?.(nousEditingAgent.id, {
          connectionId: nousConnectionId,
          model: `nous/${nousModel}`,
          thinkingLevel: "medium",
        });
      } else {
        await onCreateHostedAgent?.({
          name: nousName.trim(),
          connectionId: nousConnectionId,
          model: `nous/${nousModel}`,
          thinkingLevel: "medium",
        });
      }
      setNousStage("idle");
      setNousEditingAgent(null);
      setNousName("");
      setNousModels([]);
      setNousModel("");
    } catch (error) {
      setNousStage("configure");
      setNousError(error instanceof Error ? error.message : "Could not install the Nous agent");
    }
  }
  const data = {
    activity: { title: "Activity", copy: "Everything that needs your attention.", metric: "6 unread events", icon: "↗" },
    tasks: { title: "Tasks", copy: "Work assigned to you and your agents.", metric: "3 due today", icon: "✓" },
    members: { title: "Members", copy: "People and agents across Flock Works.", metric: "18 members · 4 agents", icon: "♙" },
    computers: { title: "Computers", copy: "Machines connected to this server.", metric: "1 computer needs attention", icon: "▣" },
  }[active];
  if (active === "computers") {
    const installCommand = enrollment
      ? buildAgentInstallCommand(
          typeof window === "undefined" ? "https://your-hub.example" : window.location.origin,
          enrollment.secret,
        )
      : "";
    return (
      <main className="utility-page">
        <div className="utility-hero"><span>{data.icon}</span><div><p className="eyebrow">FLOCK WORKS</p><h1>{data.title}</h1><p>{data.copy}</p></div></div>
        <section className="utility-card enrollment-card">
          <StatusPill tone={hostedAgentsEnabled && nousPortalEnabled ? "green" : "neutral"}>NOUS HOSTED AGENT</StatusPill>
          <h2>Create an agent on this hub</h2>
          {hostedAgentsEnabled ? (
            <>
              <p>Sign in once with Nous Portal, choose any model available to your account, and install an isolated agent on this hub.</p>
              {!nousPortalEnabled ? (
                <div className="nous-unavailable">
                  <strong>Nous Portal is not configured.</strong>
                  <span>
                    {isAdmin
                      ? "Set FLOCK_NOUS_CLIENT_ID to the client ID issued for this Flock hub."
                      : "Ask a hub administrator to configure the Nous Portal connection."}
                  </span>
                </div>
              ) : nousStage === "auth" ? (
                <div className="nous-auth-panel" aria-live="polite">
                  <StatusPill tone="yellow">WAITING FOR PORTAL</StatusPill>
                  <h3>Approve access in Nous Portal</h3>
                  {nousDevice?.type === "device_code" ? (
                    <>
                      <p>Enter this code if the Portal does not fill it automatically.</p>
                      <div className="nous-device-code">
                        <code>{nousDevice.userCode}</code>
                        <button
                          className="outline-button"
                          onClick={() => void navigator.clipboard.writeText(nousDevice.userCode)}
                        >
                          Copy
                        </button>
                      </div>
                      <a href={nousDevice.verificationUri} target="_blank" rel="noreferrer">
                        Open Nous Portal ↗
                      </a>
                    </>
                  ) : (
                    <p>Preparing a secure Nous Portal sign-in…</p>
                  )}
                  <button
                    className="outline-button"
                    onClick={() => {
                      nousAbort?.abort();
                      setNousStage("idle");
                      setNousFlow(null);
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : ["configure", "installing"].includes(nousStage) ? (
                <div className="nous-agent-builder">
                  <div className="nous-builder-heading">
                    <div>
                      <StatusPill tone="green">PORTAL CONNECTED</StatusPill>
                      <h3>{nousEditingAgent ? `Configure ${nousEditingAgent.name}` : "Choose the agent"}</h3>
                    </div>
                    <button
                      className="outline-button"
                      disabled={nousStage === "installing"}
                      onClick={() => {
                        setNousStage("idle");
                        setNousEditingAgent(null);
                      }}
                    >
                      Close
                    </button>
                  </div>
                  {!nousEditingAgent && (
                    <label>
                      Agent name
                      <input
                        autoFocus
                        value={nousName}
                        onChange={(event) => setNousName(event.target.value)}
                        placeholder="e.g. shark"
                        maxLength={64}
                      />
                    </label>
                  )}
                  <label>
                    Search models
                    <input
                      value={nousSearch}
                      onChange={(event) => setNousSearch(event.target.value)}
                      placeholder="Search by model or provider"
                    />
                  </label>
                  <label>
                    Model
                    <select
                      size={Math.min(8, Math.max(3, filteredNousModels.length))}
                      value={visibleNousModel}
                      onChange={(event) => setNousModel(event.target.value)}
                    >
                      {filteredNousModels.map((model) => (
                        <option value={model.id} key={model.id}>{model.name} · {model.id}</option>
                      ))}
                    </select>
                  </label>
                  {filteredNousModels.length === 0 && (
                    <p className="form-error">No models match “{nousSearch}”.</p>
                  )}
                  <p className="nous-disclosure">
                    Project members may dispatch work to this agent and consume the connected Nous account’s allowance.
                    Thinking is set to medium.
                  </p>
                  <button
                    className="black-button"
                    disabled={
                      nousStage === "installing"
                      || !visibleNousModel
                      || (!nousEditingAgent && !nousName.trim())
                    }
                    onClick={() => void submitNousAgent()}
                  >
                    {nousStage === "installing"
                      ? "Installing on hub…"
                      : nousEditingAgent
                        ? "Update agent"
                        : "Create agent on this hub"}
                  </button>
                </div>
              ) : (
                <button
                  className="black-button nous-primary-button"
                  onClick={() => void beginNousFlow()}
                >
                  Create an agent on this hub <span>→</span>
                </button>
              )}
              {nousError && (
                <div className="nous-error-actions">
                  <p className="form-error">{nousError}</p>
                  {nousPortalEnabled && (
                    <button
                      className="outline-button"
                      onClick={() => void beginNousFlow(nousEditingAgent, true)}
                    >
                      Reconnect Nous Portal
                    </button>
                  )}
                </div>
              )}

              <details className="advanced-provider-panel">
                <summary>Advanced providers</summary>
                <p>Connect a provider directly and choose its account, model, and thinking level.</p>
                <div className="provider-connect-list">
                  {providers.filter((provider) => provider.id !== "nous").map((provider) => {
                    const connected = advancedConnections.some(
                      (connection) => connection.providerId === provider.id && connection.status === "connected",
                    );
                    return (
                      <button
                        className={connected ? "outline-button" : "black-button"}
                        key={provider.id}
                        disabled={cloudBusy}
                        onClick={() => {
                          setCloudBusy(true);
                          setCloudError("");
                          void onConnectProvider?.(provider.id)
                            .catch((error: unknown) => setCloudError(error instanceof Error ? error.message : "Sign-in failed"))
                            .finally(() => setCloudBusy(false));
                        }}
                      >
                        {connected ? `Reconnect ${provider.name}` : `Connect ${provider.name}`}
                      </button>
                    );
                  })}
                </div>
                <div className="cloud-agent-form">
                  <input value={cloudName} onChange={(event) => setCloudName(event.target.value)} placeholder="Agent name" />
                  <select value={effectiveConnectionId} onChange={(event) => {
                    setCloudConnectionId(event.target.value);
                    setCloudModel("");
                  }}>
                    <option value="">Choose a connected account</option>
                    {advancedConnections.filter((item) => item.status === "connected").map((item) => (
                      <option value={item.id} key={item.id}>{item.providerId} · {item.label}</option>
                    ))}
                  </select>
                  <select value={effectiveModel} onChange={(event) => setCloudModel(event.target.value)}>
                    {selectedProvider?.models.map((model) => (
                      <option value={`${selectedProvider.id}/${model.id}`} key={model.id}>{model.name}</option>
                    ))}
                  </select>
                  <select value={cloudThinking} onChange={(event) => setCloudThinking(event.target.value)}>
                    {["off", "low", "medium", "high", "xhigh"].map((level) => <option key={level}>{level}</option>)}
                  </select>
                </div>
                <label className="cloud-consent">
                  <input type="checkbox" checked={cloudConsent} onChange={(event) => setCloudConsent(event.target.checked)} />
                  <span>Project members may use this agent and consume the assigned account’s allowance.</span>
                </label>
                <button
                  className="black-button"
                  disabled={cloudBusy || !cloudConsent || !effectiveConnectionId || !effectiveModel}
                  onClick={() => {
                    setCloudBusy(true);
                    setCloudError("");
                    void onCreateHostedAgent?.({
                      name: cloudName.trim() || "cloud-agent",
                      connectionId: effectiveConnectionId,
                      model: effectiveModel,
                      thinkingLevel: cloudThinking,
                    })
                      .then(() => {
                        setCloudName("");
                        setCloudConsent(false);
                      })
                      .catch((error: unknown) => setCloudError(error instanceof Error ? error.message : "Could not create agent"))
                      .finally(() => setCloudBusy(false));
                  }}
                >
                  {cloudBusy ? "Working…" : "Create advanced agent"}
                </button>
                {cloudError && <p className="form-error">{cloudError}</p>}
              </details>
            </>
          ) : (
            <p>Hosted agents are disabled. An administrator can enable the Docker runtime in hub configuration.</p>
          )}
        </section>
        {isAdmin ? (
          <section className="utility-card enrollment-card">
            <StatusPill tone="yellow">ONE-LINE INSTALL</StatusPill>
            <h2>Enroll a long-running Pi agent</h2>
            <p>Create a single-use token, then run the generated command on macOS, Linux, or Windows.</p>
            <div className="enrollment-form">
              <input value={agentName} onChange={(event) => setAgentName(event.target.value)} placeholder="Agent name, e.g. shark" />
              <button
                className="black-button"
                onClick={() => {
                  setEnrollmentError("");
                  void onCreateEnrollment?.(agentName.trim() || "agent")
                    .then(setEnrollment)
                    .catch((error: unknown) => setEnrollmentError(error instanceof Error ? error.message : "Could not create token"));
                }}
              >
                Create token
              </button>
            </div>
            {enrollment && (
              <div className="install-command">
                <code>{installCommand}</code>
                <button onClick={() => void navigator.clipboard.writeText(installCommand)}>Copy</button>
                <small>Expires {new Date(enrollment.expiresAt).toLocaleString()} · shown once</small>
              </div>
            )}
            {enrollmentError && <p className="form-error">{enrollmentError}</p>}
          </section>
        ) : (
          <section className="utility-card enrollment-card">
            <StatusPill tone="neutral">MEMBER ACCESS</StatusPill>
            <h2>Connected computers</h2>
            <p>An administrator can create the single-use token needed to enroll another agent.</p>
          </section>
        )}
        <section className="computer-list">
          {agents.map((agent) => (
            <article key={agent.id}>
              <PixelAvatar text={initials(agent.name)} color={agentColor(agent.id)} />
              <div>
                <h2>{agent.name} {agent.hosting ? <small>☁ CLOUD</small> : <small>LOCAL</small>}</h2>
                <p>{agent.model} · thinking {agent.thinkingLevel}</p>
                {agent.hosting && (
                  <p>{agent.hosting.providerId} · {agent.hosting.connectionLabel} · {agent.hosting.runtimeState}</p>
                )}
                {agent.hosting?.lastError && <p className="form-error">{agent.hosting.lastError}</p>}
              </div>
              {agent.hosting && (
                <div className="cloud-agent-actions">
                  <button
                    className="outline-button"
                    onClick={() => {
                      if (agent.hosting?.providerId === "nous") {
                        void beginNousFlow(agent);
                        return;
                      }
                      const ownedDefault = providerConnections.find(
                        (connection) => connection.id === agent.hosting?.connectionId,
                      ) ?? advancedConnections.find((connection) => connection.status === "connected");
                      if (!ownedDefault) {
                        setCloudError("Connect one of your own provider accounts before reconfiguring this agent.");
                        return;
                      }
                      const connectionId = window.prompt(
                        `Assign one of your connection IDs:\n${advancedConnections
                          .filter((connection) => connection.status === "connected")
                          .map((connection) => `${connection.id} — ${connection.providerId} · ${connection.label}`)
                          .join("\n")}`,
                        ownedDefault.id,
                      );
                      if (!connectionId) return;
                      const connection = advancedConnections.find((item) => item.id === connectionId);
                      const provider = providers.find((item) => item.id === connection?.providerId);
                      if (!connection || !provider) {
                        setCloudError("Choose a valid connected account.");
                        return;
                      }
                      const model = window.prompt(
                        `Model (${provider.name}):\n${provider.models.slice(0, 30).map((item) => item.id).join("\n")}`,
                        `${provider.id}/${provider.models[0]?.id ?? ""}`,
                      );
                      if (!model) return;
                      const thinkingLevel = window.prompt("Thinking level", agent.thinkingLevel);
                      if (!thinkingLevel) return;
                      void onUpdateHostedAgent?.(agent.id, { connectionId, model, thinkingLevel })
                        .catch((error: unknown) => setCloudError(error instanceof Error ? error.message : "Update failed"));
                    }}
                  >
                    Configure
                  </button>
                  <button
                    className="outline-button"
                    onClick={() => void onUpdateHostedAgent?.(agent.id, {
                      desiredState: agent.hosting?.desiredState === "running" ? "stopped" : "running",
                    }).catch((error: unknown) => setCloudError(error instanceof Error ? error.message : "Update failed"))}
                  >
                    {agent.hosting.desiredState === "running" ? "Stop" : "Start"}
                  </button>
                  <button
                    className="outline-button"
                    onClick={() => {
                      if (!window.confirm(`Delete ${agent.name}? Its workspace is retained temporarily for recovery.`)) return;
                      void onDeleteHostedAgent?.(agent.id)
                        .catch((error: unknown) => setCloudError(error instanceof Error ? error.message : "Delete failed"));
                    }}
                  >
                    Delete
                  </button>
                </div>
              )}
              <StatusPill tone={agent.status === "offline" ? "pink" : agent.status === "busy" ? "yellow" : "green"}>{agent.status.toUpperCase()}</StatusPill>
            </article>
          ))}
          {agents.length === 0 && <article><div><h2>No agents enrolled</h2><p>Create the first installation token above.</p></div></article>}
        </section>
      </main>
    );
  }
  return (
    <main className="utility-page">
      <div className="utility-hero"><span>{data.icon}</span><div><p className="eyebrow">FLOCK WORKS</p><h1>{data.title}</h1><p>{data.copy}</p></div></div>
      <section className="utility-card"><StatusPill tone="yellow">{data.metric.toUpperCase()}</StatusPill><h2>Your workspace is in sync.</h2><p>This focused view is ready for the server-backed activity stream.</p><button className="black-button">View details</button></section>
    </main>
  );
}

export default function Workspace() {
  const hub = useHubState();
  const pathname = usePathname() || "/app";
  const router = useRouter();
  const parsedRoute = useMemo(() => parseWorkspacePath(pathname), [pathname]);
  const routeView = parsedRoute.valid ? parsedRoute.view : defaultWorkspaceView;
  const activeNav = routeView.nav;
  const chatTab = routeView.chatTab;
  const setting =
    hub.identity?.role === "member" &&
    activeNav === "settings" &&
    adminOnlySettings.has(routeView.setting)
      ? "account"
      : routeView.setting;
  const [channel, setChannel] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");

  useEffect(() => {
    if (!hub.identity) return;
    const canonicalPath = canonicalWorkspacePath(pathname, hub.identity);
    if (pathname !== canonicalPath) router.replace(canonicalPath);
  }, [hub.identity, pathname, router]);

  const navigateTo = useCallback((view: WorkspaceView) => {
    const username = hub.identity
      ? usernameSlug(hub.identity.email)
      : parsedRoute.username ?? "user";
    router.push(buildWorkspacePath(username, view));
  }, [hub.identity, parsedRoute.username, router]);

  const navigateNav = useCallback((nav: NavKey) => {
    navigateTo({ ...defaultWorkspaceView, nav });
  }, [navigateTo]);

  const content = useMemo(() => {
    if (activeNav === "settings") {
      return (
        <SettingsWorkspace
          setting={setting}
          onSetting={(nextSetting) => navigateTo({
            ...defaultWorkspaceView,
            nav: "settings",
            setting: nextSetting,
          })}
          onToast={showToast}
          identity={hub.identity}
          onLogout={hub.logout}
        />
      );
    }
    if (activeNav !== "chat") {
      return (
        <UtilityPage
          active={activeNav}
          agents={hub.agents}
          onCreateEnrollment={hub.createEnrollment}
          hostedAgentsEnabled={hub.hostedAgentsEnabled}
          nousPortalEnabled={hub.nousPortalEnabled}
          providers={hub.llmProviders}
          providerConnections={hub.providerConnections}
          onConnectProvider={hub.connectProvider}
          onLoadConnectionModels={hub.loadConnectionModels}
          onCreateHostedAgent={hub.createHostedAgent}
          onUpdateHostedAgent={hub.updateHostedAgent}
          onDeleteHostedAgent={hub.deleteHostedAgent}
          isAdmin={hub.identity?.role === "admin"}
        />
      );
    }
    return (
      <>
        <ConversationSidebar
          current={channel}
          onChannel={setChannel}
          mobileOpen={sidebarOpen}
          onClose={() => setSidebarOpen(false)}
          project={hub.project}
          agents={hub.agents}
          identity={hub.identity}
        />
        <ChannelWorkspace
          onOpenSidebar={() => setSidebarOpen(true)}
          tab={chatTab}
          onTab={(nextTab) => navigateTo({
            ...defaultWorkspaceView,
            nav: "chat",
            chatTab: nextTab,
          })}
          messages={hub.messages}
          agents={hub.agents}
          dispatches={hub.dispatches}
          connection={hub.connection}
          onDispatch={hub.sendDispatch}
          onSelectBranch={hub.selectBranch}
        />
      </>
    );
  }, [activeNav, channel, chatTab, setting, sidebarOpen, hub, navigateTo]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  return (
    <div className="app-shell">
      <GlobalRail active={activeNav} onChange={navigateNav} onSearch={() => setSearchOpen(true)} onServer={() => setServerOpen(!serverOpen)} />
      {content}
      {serverOpen && (
        <div className="server-switcher">
          <span className="eyebrow">YOUR SERVERS</span>
          {hub.projects.map((project, index) => (
            <button
              className={hub.projectId === project.id ? "active" : ""}
              key={project.id}
              onClick={() => {
                hub.setProjectId(project.id);
                setServerOpen(false);
              }}
            >
              <span className={`server-mark mini ${index ? "alt" : ""}`}>{project.name[0]?.toUpperCase()}</span>
              <div><strong>{project.name}</strong><small>{project.slug}</small></div>
              {hub.projectId === project.id && <b>✓</b>}
            </button>
          ))}
          {hub.projects.length === 0 && <button className="active"><span className="server-mark mini"><img src="/flock.png" alt="" /></span><div><strong>Flock Works</strong><small>Connecting…</small></div></button>}
          {hub.identity?.role === "admin" && <button className="add-server">＋ Create or join server</button>}
        </div>
      )}
      {searchOpen && (
        <div className="search-overlay" role="dialog" aria-modal="true" aria-label="Search">
          <button className="overlay-dismiss" onClick={() => setSearchOpen(false)} aria-label="Close search" />
          <div className="search-palette">
            <div className="search-input"><span>⌕</span><input autoFocus placeholder="Search messages, tasks, people, and files…" /><kbd>ESC</kbd></div>
            <div className="search-results"><span className="eyebrow">RECENT</span><button><b># all</b><span>Channel</span></button><button><b>shark</b><span>Agent</span></button><button><b>Hub launch checklist</b><span>Pinned</span></button></div>
          </div>
        </div>
      )}
      {sidebarOpen && <button className="mobile-backdrop" onClick={() => setSidebarOpen(false)} aria-label="Close sidebar" />}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </div>
  );
}
