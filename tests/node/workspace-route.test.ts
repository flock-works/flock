import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspacePath,
  canonicalWorkspacePath,
  defaultWorkspaceView,
  parseWorkspacePath,
  settingKeys,
  usernameSlug,
  type WorkspaceView,
} from "../../app/workspace-route.ts";

test("derives safe username slugs from email local parts", () => {
  assert.equal(usernameSlug("Edward@Example.com"), "edward");
  assert.equal(usernameSlug("Jane.Doe+Agents@example.com"), "jane.doe-agents");
  assert.equal(usernameSlug("...@example.com"), "user");
  assert.equal(usernameSlug("🤖@example.com"), "user");
});

test("builds and parses every canonical workspace view", () => {
  const views: WorkspaceView[] = [
    { ...defaultWorkspaceView, nav: "chat", chatTab: "chat" },
    { ...defaultWorkspaceView, nav: "chat", chatTab: "tasks" },
    { ...defaultWorkspaceView, nav: "chat", chatTab: "files" },
    { ...defaultWorkspaceView, nav: "activity" },
    { ...defaultWorkspaceView, nav: "tasks" },
    { ...defaultWorkspaceView, nav: "members" },
    { ...defaultWorkspaceView, nav: "computers" },
    ...settingKeys.map(
      (setting): WorkspaceView => ({
        ...defaultWorkspaceView,
        nav: "settings",
        setting,
      }),
    ),
  ];

  for (const view of views) {
    const path = buildWorkspacePath("edward", view);
    const parsed = parseWorkspacePath(path);
    assert.equal(parsed.valid, true, path);
    assert.equal(parsed.legacy, false, path);
    assert.equal(parsed.username, "edward", path);
    assert.deepEqual(parsed.view, view, path);
  }

  assert.equal(
    buildWorkspacePath("edward", {
      ...defaultWorkspaceView,
      nav: "chat",
      chatTab: "chat",
    }),
    "/edward/chat",
  );
  assert.equal(
    buildWorkspacePath("edward", {
      ...defaultWorkspaceView,
      nav: "settings",
      setting: "account",
    }),
    "/edward/settings",
  );
});

test("canonicalizes legacy, mismatched, invalid, and restricted routes", () => {
  const admin = {
    email: "Edward@example.com",
    role: "admin" as const,
  };
  const member = {
    email: "member@example.com",
    role: "member" as const,
  };

  assert.equal(canonicalWorkspacePath("/app", admin), "/edward/chat");
  assert.equal(
    canonicalWorkspacePath("/someone-else/chat/files", admin),
    "/edward/chat/files",
  );
  assert.equal(
    canonicalWorkspacePath("/someone-else/settings/account", admin),
    "/edward/settings",
  );
  assert.equal(
    canonicalWorkspacePath("/edward/not-a-tab", admin),
    "/edward/chat",
  );
  assert.equal(
    canonicalWorkspacePath("/member/settings/billing", member),
    "/member/settings",
  );
  assert.equal(
    canonicalWorkspacePath("/member/settings/notifications", member),
    "/member/settings/notifications",
  );
});
