"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type NavKey = "chat" | "activity" | "tasks" | "members" | "computers" | "settings";
type ChatTab = "chat" | "tasks" | "files";
type SettingKey =
  | "account"
  | "language"
  | "appearance"
  | "notifications"
  | "server-profile"
  | "billing"
  | "administration"
  | "applications"
  | "mcp"
  | "about"
  | "documentation"
  | "release-notes";

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

type HubAgent = {
  id: string;
  name: string;
  status: string;
  model: string;
  thinkingLevel: string;
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
  const [identity, setIdentity] = useState<{ sub: string; displayName: string; role: string } | null>(null);
  const [projects, setProjects] = useState<HubProject[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [agents, setAgents] = useState<HubAgent[]>([]);
  const [dispatches, setDispatches] = useState<HubDispatch[]>([]);
  const [entries, setEntries] = useState<HubEntry[]>([]);
  const [connection, setConnection] = useState<"connecting" | "live" | "offline">("connecting");

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
      fetchJson<{ user: { sub: string; displayName: string; role: string } }>("/api/v1/me"),
      fetchJson<{ projects: HubProject[] }>("/api/v1/projects"),
    ])
      .then(([me, projectResult]) => {
        if (cancelled) return;
        setIdentity(me.user);
        setProjects(projectResult.projects);
        setProjectId((current) => current ?? projectResult.projects[0]?.id ?? null);
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
    void refreshProject(projectId).catch(() => setConnection("offline"));
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
        text: text || "The model run ended with an error.",
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
          R
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
          <span className="eyebrow">WORKSPACE</span>
          <strong>{project?.name ?? "Raft Works"}</strong>
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
}: {
  message: UiMessage;
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
        {message.thread && <button className="thread-preview"><span className="thread-lines">↳</span>{message.thread}<b>→</b></button>}
        {message.reactions && (
          <div className="reactions">{message.reactions.map((reaction) => <button key={reaction}>{reaction}</button>)}<button>＋</button></div>
        )}
      </div>
    </article>
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
  messages: hubMessages,
  agents,
  dispatches,
  connection,
  onDispatch,
  onSelectBranch,
}: {
  onOpenSidebar: () => void;
  messages: UiMessage[];
  agents: HubAgent[];
  dispatches: HubDispatch[];
  connection: "connecting" | "live" | "offline";
  onDispatch: (text: string, targetAgentIds: string[]) => Promise<void>;
  onSelectBranch: (dispatchId: string, leafId: string) => Promise<void>;
}) {
  const [tab, setTab] = useState<ChatTab>("chat");
  const [localMessages, setLocalMessages] = useState<UiMessage[]>([]);
  const [muted, setMuted] = useState(false);
  const [agentMenu, setAgentMenu] = useState(false);
  const [targets, setTargets] = useState<string[]>([]);

  useEffect(() => {
    setTargets((current) => {
      const valid = current.filter((id) => agents.some((agent) => agent.id === id));
      return valid.length > 0 ? valid : agents.filter((agent) => agent.status !== "revoked").map((agent) => agent.id);
    });
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
          <button key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}>
            {key[0].toUpperCase() + key.slice(1)}
            {key === "tasks" && <em>3</em>}
          </button>
        ))}
      </nav>
      {tab === "chat" && (
        <>
          <div className="message-feed">
            <div className="channel-intro">
              <div className="hash-box">#</div>
              <h2>Welcome to #all</h2>
              <p>This is the start of the company-wide channel. Everyone and every shared agent can participate.</p>
            </div>
            <div className="date-separator"><span>MONDAY, JULY 27</span></div>
            <div className="system-event"><span>✦</span><p><strong>Cindy joined #all</strong> via the owner onboarding flow.</p><time>9:32 AM</time></div>
            {[...hubMessages, ...localMessages].map((message) => <Message key={message.id} message={message} />)}
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

function TextField({ value }: { value: string }) {
  return <input defaultValue={value} />;
}

function SelectField({ value, children }: { value: string; children?: React.ReactNode }) {
  return <select defaultValue={value}>{children ?? <option>{value}</option>}</select>;
}

function SettingsContent({ page, onToast }: { page: SettingKey; onToast: (message: string) => void }) {
  const pageTitle = settingGroups.flatMap((group) => group.items).find((item) => item.key === page)?.label.replace(" ↗", "") ?? "";

  function Header({ kicker, summary }: { kicker: string; summary: string }) {
    return (
      <div className="settings-content-header">
        <span className="eyebrow">{kicker}</span>
        <h1>{pageTitle}</h1>
        <p>{summary}</p>
      </div>
    );
  }

  if (page === "account") {
    return (
      <>
        <Header kicker="PERSONAL SETTINGS" summary="Manage how you appear across Raft and keep your account secure." />
        <section className="settings-card profile-card">
          <PixelAvatar text="ED" color="yellow" size="lg" />
          <div><h2>Edward</h2><p>@edward · Owner</p></div>
          <button className="outline-button" onClick={() => onToast("Avatar editor opened")}>Change avatar</button>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Display name" description="Shown in messages and member lists."><TextField value="Edward" /></FieldRow>
          <FieldRow label="Username" description="Your unique Raft handle."><div className="input-prefix"><span>@</span><TextField value="edward" /></div></FieldRow>
          <FieldRow label="Email" description="Verified on July 12, 2026."><div className="verified-input"><TextField value="edward@raft.works" /><StatusPill tone="green">VERIFIED</StatusPill></div></FieldRow>
          <div className="form-actions"><button className="black-button" onClick={() => onToast("Account changes saved")}>Save changes</button></div>
        </section>
        <section className="settings-card">
          <div className="card-heading"><div><h2>Connected accounts</h2><p>Use these providers to sign in.</p></div></div>
          <div className="connection-row"><span className="provider-logo">G</span><div><strong>Google</strong><p>edward@raft.works</p></div><StatusPill tone="green">CONNECTED</StatusPill><button>Disconnect</button></div>
          <div className="connection-row"><span className="provider-logo dark">GH</span><div><strong>GitHub</strong><p>Not connected</p></div><button className="outline-button">Connect</button></div>
        </section>
        <section className="settings-card">
          <div className="card-heading"><div><h2>Password & session</h2><p>Last changed 42 days ago.</p></div><button className="outline-button">Change password</button></div>
          <button className="danger-text" onClick={() => onToast("Logged out of other devices")}>Log out of all other devices</button>
        </section>
        <button className="logout-button">Log out</button>
      </>
    );
  }

  if (page === "language") {
    return (
      <>
        <Header kicker="PERSONAL SETTINGS" summary="Choose how dates, times, and translated messages appear." />
        <section className="settings-card form-card">
          <FieldRow label="Display language" description="The language used across the Raft interface."><SelectField value="English (US)"><option>English (US)</option><option>Deutsch</option><option>日本語</option></SelectField></FieldRow>
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
        <Header kicker="PERSONAL SETTINGS" summary="Tune message density and how active agents show their work." />
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
        <Header kicker="PERSONAL SETTINGS" summary="Control push notifications and quiet individual servers." />
        <section className="settings-card push-card">
          <div className="push-icon">◉</div><div><StatusPill tone="green">ENABLED</StatusPill><h2>Push notifications are active</h2><p>This browser can receive mentions, task assignments, and agent completions.</p></div>
          <button className="outline-button" onClick={() => onToast("Test notification sent")}>Send test push</button>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Mentions and replies"><SelectField value="Immediately" /></FieldRow>
          <FieldRow label="Task assignments"><Switch defaultOn label="Task assignments" /></FieldRow>
          <FieldRow label="Agent completions"><Switch defaultOn label="Agent completions" /></FieldRow>
          <FieldRow label="Mute Raft Works" description="Pause all non-critical alerts from this server."><Switch label="Mute Raft Works" /></FieldRow>
        </section>
        <button className="danger-outline">Disable push notifications</button>
      </>
    );
  }

  if (page === "server-profile") {
    return (
      <>
        <Header kicker="WORKSPACE SETTINGS" summary="Update the public identity of this Raft server." />
        <section className="settings-card profile-card server-card">
          <span className="server-image">R</span><div><h2>Raft Works</h2><p>18 members · 4 agents</p></div><button className="outline-button">Upload image</button>
        </section>
        <section className="settings-card form-card">
          <FieldRow label="Server name"><TextField value="Raft Works" /></FieldRow>
          <FieldRow label="Server slug" description="raft.app/"><div className="input-prefix wide"><span>raft.app/</span><TextField value="raft-works" /></div></FieldRow>
          <div className="form-actions"><button className="black-button" onClick={() => onToast("Server profile saved")}>Save server</button></div>
        </section>
        <section className="settings-card danger-zone"><div><span className="eyebrow">DANGER ZONE</span><h2>Delete this server</h2><p>Permanently remove every channel, message, task, agent enrollment, and file.</p></div><button>Delete Server</button></section>
      </>
    );
  }

  if (page === "billing") {
    return (
      <>
        <Header kicker="WORKSPACE SETTINGS" summary="Review your current plan, usage, and next invoice." />
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
        <Header kicker="WORKSPACE SETTINGS" summary="Set server-wide permissions, onboarding, and member access." />
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
        <Header kicker="WORKSPACE SETTINGS" summary="Connect services or register an application for your team." />
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
        <Header kicker="WORKSPACE SETTINGS" summary="Give agents approved access to tools and knowledge through MCP." />
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
        <Header kicker="ABOUT" summary="Product information and the identity of your current workspace." />
        <section className="about-hero"><span className="about-logo">R</span><div><h2>Raft</h2><p>A shared place for people and long-running agents to work together.</p><StatusPill tone="neutral">DESKTOP WEB · V0.9.4</StatusPill></div></section>
        <section className="settings-card form-card">
          <FieldRow label="Current workspace"><strong>Raft Works</strong></FieldRow>
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
        <Header kicker="ABOUT" summary="Guides for members, administrators, and agent developers." />
        <section className="docs-card">
          <span>↗</span><div><h2>Read the Raft documentation</h2><p>Set up a server, enroll your first agent, manage session trees, and learn the hub protocol.</p><button className="black-button">Open documentation ↗</button></div>
        </section>
        <div className="docs-links"><button>Getting started <span>→</span></button><button>Agent protocol <span>→</span></button><button>Administration <span>→</span></button></div>
      </>
    );
  }

  return (
    <>
      <Header kicker="ABOUT" summary="What’s new across collaboration, agents, and administration." />
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
}: {
  setting: SettingKey;
  onSetting: (key: SettingKey) => void;
  onToast: (message: string) => void;
}) {
  return (
    <div className="settings-shell">
      <aside className="settings-menu">
        <div className="settings-menu-header"><span className="eyebrow">RAFT WORKS</span><h1>Settings</h1></div>
        <div className="settings-menu-scroll">
          {settingGroups.map((group) => (
            <section key={group.title}>
              <h2>{group.title}</h2>
              {group.items.map((item) => (
                <button key={item.key} className={setting === item.key ? "active" : ""} onClick={() => onSetting(item.key)}>
                  <span>{item.label}</span>{setting === item.key && <b>→</b>}
                </button>
              ))}
            </section>
          ))}
        </div>
        <div className="owner-view"><PixelAvatar text="ED" color="yellow" size="sm" /><div><strong>Owner view</strong><span>All controls visible</span></div></div>
      </aside>
      <main className="settings-content">
        <div className="settings-content-inner"><SettingsContent page={setting} onToast={onToast} /></div>
      </main>
    </div>
  );
}

function UtilityPage({
  active,
  agents = [],
  onCreateEnrollment,
}: {
  active: Exclude<NavKey, "chat" | "settings">;
  agents?: HubAgent[];
  onCreateEnrollment?: (name: string) => Promise<{ secret: string; expiresAt: string }>;
}) {
  const [agentName, setAgentName] = useState("");
  const [enrollment, setEnrollment] = useState<{ secret: string; expiresAt: string } | null>(null);
  const [enrollmentError, setEnrollmentError] = useState("");
  const [hubOrigin, setHubOrigin] = useState("https://your-hub.example");
  useEffect(() => setHubOrigin(window.location.origin), []);
  const data = {
    activity: { title: "Activity", copy: "Everything that needs your attention.", metric: "6 unread events", icon: "↗" },
    tasks: { title: "Tasks", copy: "Work assigned to you and your agents.", metric: "3 due today", icon: "✓" },
    members: { title: "Members", copy: "People and agents across Raft Works.", metric: "18 members · 4 agents", icon: "♙" },
    computers: { title: "Computers", copy: "Machines connected to this server.", metric: "1 computer needs attention", icon: "▣" },
  }[active];
  if (active === "computers") {
    const installCommand = enrollment
      ? `npm install -g @flock-works/flock@latest && flock agent install --hub ${hubOrigin} --enrollment ${enrollment.secret} --workspace "$PWD" --name ${JSON.stringify(agentName || "agent")}`
      : "";
    return (
      <main className="utility-page">
        <div className="utility-hero"><span>{data.icon}</span><div><p className="eyebrow">RAFT WORKS</p><h1>{data.title}</h1><p>{data.copy}</p></div></div>
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
        <section className="computer-list">
          {agents.map((agent) => (
            <article key={agent.id}>
              <PixelAvatar text={initials(agent.name)} color={agentColor(agent.id)} />
              <div><h2>{agent.name}</h2><p>{agent.model} · thinking {agent.thinkingLevel}</p></div>
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
      <div className="utility-hero"><span>{data.icon}</span><div><p className="eyebrow">RAFT WORKS</p><h1>{data.title}</h1><p>{data.copy}</p></div></div>
      <section className="utility-card"><StatusPill tone="yellow">{data.metric.toUpperCase()}</StatusPill><h2>Your workspace is in sync.</h2><p>This focused view is ready for the server-backed activity stream.</p><button className="black-button">View details</button></section>
    </main>
  );
}

export default function Home() {
  const hub = useHubState();
  const [activeNav, setActiveNav] = useState<NavKey>("chat");
  const [setting, setSetting] = useState<SettingKey>("account");
  const [channel, setChannel] = useState("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [serverOpen, setServerOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [toast, setToast] = useState("");

  const content = useMemo(() => {
    if (activeNav === "settings") return <SettingsWorkspace setting={setting} onSetting={setSetting} onToast={showToast} />;
    if (activeNav !== "chat") {
      return <UtilityPage active={activeNav} agents={hub.agents} onCreateEnrollment={hub.createEnrollment} />;
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
          messages={hub.messages}
          agents={hub.agents}
          dispatches={hub.dispatches}
          connection={hub.connection}
          onDispatch={hub.sendDispatch}
          onSelectBranch={hub.selectBranch}
        />
      </>
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeNav, channel, setting, sidebarOpen, hub]);

  function showToast(message: string) {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }

  return (
    <div className="app-shell">
      <GlobalRail active={activeNav} onChange={setActiveNav} onSearch={() => setSearchOpen(true)} onServer={() => setServerOpen(!serverOpen)} />
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
          {hub.projects.length === 0 && <button className="active"><span className="server-mark mini">R</span><div><strong>Raft Works</strong><small>Connecting…</small></div></button>}
          <button className="add-server">＋ Create or join server</button>
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
