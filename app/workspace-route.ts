export type NavKey =
  | "chat"
  | "activity"
  | "tasks"
  | "members"
  | "computers"
  | "settings";

export type ChatTab = "chat" | "tasks" | "files";

export const settingKeys = [
  "account",
  "language",
  "appearance",
  "notifications",
  "server-profile",
  "billing",
  "administration",
  "applications",
  "mcp",
  "about",
  "documentation",
  "release-notes",
] as const;

export type SettingKey = (typeof settingKeys)[number];

export type WorkspaceView = {
  nav: NavKey;
  chatTab: ChatTab;
  setting: SettingKey;
};

export type ParsedWorkspaceRoute = {
  username: string | null;
  view: WorkspaceView;
  valid: boolean;
  legacy: boolean;
};

export const defaultWorkspaceView: WorkspaceView = {
  nav: "chat",
  chatTab: "chat",
  setting: "account",
};

const utilityNavKeys = new Set<NavKey>([
  "activity",
  "tasks",
  "members",
  "computers",
]);

const settingKeySet = new Set<SettingKey>(settingKeys);

export const adminOnlySettings = new Set<SettingKey>([
  "server-profile",
  "billing",
  "administration",
  "applications",
  "mcp",
]);

export function usernameSlug(email: string): string {
  const localPart = email.split("@", 1)[0]?.toLowerCase() ?? "";
  const slug = localPart
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");
  return slug || "user";
}

export function parseWorkspacePath(pathname: string): ParsedWorkspaceRoute {
  const normalizedPath = pathname.split(/[?#]/, 1)[0] ?? pathname;
  if (normalizedPath === "/app" || normalizedPath === "/app/") {
    return {
      username: null,
      view: defaultWorkspaceView,
      valid: true,
      legacy: true,
    };
  }

  const segments = normalizedPath
    .split("/")
    .filter(Boolean)
    .map(safeDecodeURIComponent);
  const username = segments[0] || null;
  const tabPath = segments.slice(1);

  if (!username || tabPath.length === 0) {
    return invalidRoute(username);
  }

  const [section, detail] = tabPath;
  if (section === "chat" && tabPath.length <= 2) {
    const chatTab = detail ?? "chat";
    if (chatTab === "chat" || chatTab === "tasks" || chatTab === "files") {
      return {
        username,
        view: { ...defaultWorkspaceView, nav: "chat", chatTab },
        valid: true,
        legacy: false,
      };
    }
  }

  if (
    tabPath.length === 1 &&
    utilityNavKeys.has(section as NavKey)
  ) {
    return {
      username,
      view: {
        ...defaultWorkspaceView,
        nav: section as Exclude<NavKey, "chat" | "settings">,
      },
      valid: true,
      legacy: false,
    };
  }

  if (section === "settings" && tabPath.length <= 2) {
    const setting = detail ?? "account";
    if (settingKeySet.has(setting as SettingKey)) {
      return {
        username,
        view: {
          ...defaultWorkspaceView,
          nav: "settings",
          setting: setting as SettingKey,
        },
        valid: true,
        legacy: false,
      };
    }
  }

  return invalidRoute(username);
}

export function buildWorkspacePath(
  username: string,
  view: WorkspaceView,
): string {
  const encodedUsername = encodeURIComponent(username || "user");
  if (view.nav === "chat") {
    return view.chatTab === "chat"
      ? `/${encodedUsername}/chat`
      : `/${encodedUsername}/chat/${view.chatTab}`;
  }
  if (view.nav === "settings") {
    return view.setting === "account"
      ? `/${encodedUsername}/settings`
      : `/${encodedUsername}/settings/${view.setting}`;
  }
  return `/${encodedUsername}/${view.nav}`;
}

export function canonicalWorkspacePath(
  pathname: string,
  identity: { email: string; role: "admin" | "member" },
): string {
  const parsed = parseWorkspacePath(pathname);
  let view = parsed.valid ? parsed.view : defaultWorkspaceView;
  if (
    identity.role !== "admin" &&
    view.nav === "settings" &&
    adminOnlySettings.has(view.setting)
  ) {
    view = { ...defaultWorkspaceView, nav: "settings" };
  }
  return buildWorkspacePath(usernameSlug(identity.email), view);
}

function invalidRoute(username: string | null): ParsedWorkspaceRoute {
  return {
    username,
    view: defaultWorkspaceView,
    valid: false,
    legacy: false,
  };
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return "";
  }
}
