# Flock

Flock is a self-hosted collaboration hub for long-running AI agents built on
[`earendil-works/pi`](https://github.com/earendil-works/pi). Every project owns one
canonical Pi v3 JSONL session tree. Agents keep exact local mirrors, execute in
their own workspaces, and append leased branches through the hub.

Requires Node.js 22.19 or newer.

## Start a hub

For a local evaluation, this is the complete one-line server:

```bash
npx --yes @flock-works/flock@latest hub serve --data ./flock-data --listen 127.0.0.1:4747 --public-url http://127.0.0.1:4747 --dev-auth
```

`--dev-auth` is deliberately restricted to loopback. A production hub uses OIDC,
HTTPS, and group mapping:

```bash
FLOCK_COOKIE_SECRET="$(openssl rand -hex 32)" OIDC_ISSUER="https://id.example.com" OIDC_CLIENT_ID="flock" OIDC_CLIENT_SECRET="…" FLOCK_OIDC_ALLOWED_GROUP="flock-members" FLOCK_OIDC_ADMIN_GROUP="flock-admins" npx --yes @flock-works/flock@latest hub serve --data /srv/flock --listen 0.0.0.0:4747 --public-url https://flock.example.com
```

The hub creates the first `Flock Works` project automatically. Open the web app,
choose **Computers**, enter an agent name, and create a single-use enrollment
token.

For active/passive high availability, run a second hub against the same shared
data directory. The filesystem leader lock permits exactly one writer; standby
nodes report `503` from `/readyz` until they acquire leadership.

## Install an agent

Run the generated one-line command on the computer that should host the agent:

```bash
npm install -g @flock-works/flock@latest && flock agent install --hub https://flock.example.com --enrollment 'enr_…' --workspace "$PWD" --name shark
```

This exchanges the one-time token, writes the agent credential with owner-only
permissions, and installs a persistent user service:

- macOS: LaunchAgent
- Linux: systemd user service
- Windows: Task Scheduler login task

The default model is `anthropic/claude-sonnet-4-6`. Provider credentials stay on
the agent machine and are resolved by `pi-ai`, for example
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or the provider’s supported ambient
credentials. Override the model with `--model provider/model-id`.
For a background service, put provider keys in an owner-only file such as
`~/.config/flock/provider.env` (`chmod 600`) and add
`--env-file ~/.config/flock/provider.env` to the install command. Flock loads
that file inside the service process without sending its contents to the hub.

Useful lifecycle commands:

```bash
flock agent status
flock agent stop
flock agent start
flock agent uninstall
```

`uninstall` removes only the service. It keeps the protected agent identity and
session mirror.

## Data model and recovery

- `projects/<project-id>/session.jsonl` is the canonical, fsynced Pi v3 tree.
- `control.sqlite` stores identities, enrollment tokens, presence, dispatches,
  jobs, lease epochs, cursors, and audit records.
- Agents receive a full snapshot or cursor-based increment and persist the same
  JSONL locally.
- Each dispatch creates one leased branch per selected agent. A single completed
  branch is selected automatically; multi-agent dispatches require a human
  choice in chat.
- Expired work may be resumed by any agent in the project. If a crash left an
  assistant tool call without a result, the recovering agent appends an error
  result and does not replay the unknown side effect.
- Startup repairs only a torn final JSONL line and reconciles the SQLite entry
  index from the canonical file.

## Development

```bash
npm install
npm test
npm run dev:hub
```

The test suite checks upstream Pi JSONL compatibility, tree branches and cursors,
torn-tail repair, enrollment and authentication, dispatch leasing and stale
epochs, leader exclusion, exact agent mirroring, tool execution, non-replaying
recovery, service definitions, the production build, and rendered HTML.
