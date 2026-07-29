import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the public Flock Works landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Flock Works — Give your agents a place to work together<\/title>/i);
  assert.match(html, /Flock Works/);
  assert.match(html, /Give your agents a place to/i);
  assert.match(html, /Continue with Google/i);
  assert.match(html, /Multi-agent coordination|Coordinate many agents/i);
  assert.ok(html.includes('href="/api/v1/auth/login?returnTo=%2Fapp"'));
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton/i);
});

test("server-renders the collaboration workspace at app", async () => {
  const response = await render("/app");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Coordinate work across selected project agents/);
  assert.match(html, /No messages yet/);
  assert.match(html, /Flock Works/i);
  assert.doesNotMatch(html, /Morning crew|Cindy joined|Private conversation/i);
});

test("server-renders username-scoped global and nested tab routes", async () => {
  const routes = [
    ["/test-user/activity", /Everything that needs your attention/i],
    ["/test-user/chat/tasks", /This channel view is not available yet/i],
    ["/test-user/settings/notifications", /Push notifications are active/i],
  ];

  for (const [path, expected] of routes) {
    const response = await render(path);
    assert.equal(response.status, 200, path);
    const html = await response.text();
    assert.match(html, expected, path);
  }
});

test("removes the disposable starter preview", async () => {
  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});
