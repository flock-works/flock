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

### Sign in with Google

Flock can also accept any verified Google account while reserving administrator
controls for explicitly configured email addresses. Create a **Web application**
OAuth client in Google Cloud and register this exact authorized redirect URI:

```text
https://flock.example.com/api/v1/auth/callback
```

The scheme, hostname, port, path, and trailing slash must match the
`--public-url` callback exactly. Keep the Google client secret outside the
repository, then start the hub with Google-open access:

```bash
FLOCK_COOKIE_SECRET="$(openssl rand -hex 32)" FLOCK_OIDC_ACCESS_MODE="google-open" FLOCK_OIDC_ADMIN_EMAILS="owner@example.com,admin@example.com" OIDC_ISSUER="https://accounts.google.com" OIDC_CLIENT_ID="your-client-id.apps.googleusercontent.com" OIDC_CLIENT_SECRET="…" npx --yes @flock-works/flock@latest hub serve --data /srv/flock --listen 0.0.0.0:4747 --public-url https://flock.example.com
```

Every Google identity must include a verified email. Addresses listed in
`FLOCK_OIDC_ADMIN_EMAILS` are matched case-insensitively and receive the
`admin` role; all other verified Google users receive the `member` role. The
hub refuses to start in `google-open` mode if the issuer is not Google or the
administrator list is empty. Group-based OIDC remains the default when
`FLOCK_OIDC_ACCESS_MODE` is unset.

For local Google sign-in, add
`http://localhost:4747/api/v1/auth/callback` as an authorized redirect URI in
the same Google OAuth client. Then create the ignored local environment file
and replace its placeholders:

```bash
cp .env.google.example .env.google
openssl rand -hex 32
```

Paste the generated value into `FLOCK_COOKIE_SECRET` in `.env.google`, then run:

```bash
npm run build
npm run dev:hub:google
```

Open `http://localhost:4747`. The hostname must remain `localhost` because the
Google redirect URI must match exactly. A hub that is also configured with a
public tunnel URL detects direct loopback requests and keeps the Google callback
and post-login redirect on that loopback origin.

### Publish through Cloudflare Tunnel

Cloudflare Tunnel can expose the complete Node hub without opening an inbound
port. This keeps SQLite and canonical JSONL data on the hub machine, so the
machine and its `cloudflared` connector must remain online:

```bash
cloudflared tunnel create flock
cloudflared tunnel route dns flock flock.example.com
```

Point the tunnel ingress at `http://127.0.0.1:4747`, set
`FLOCK_PUBLIC_URL=https://flock.example.com`, and add the matching Google
callback:

```text
https://flock.example.com/api/v1/auth/callback
```

Flock accepts `FLOCK_PUBLIC_URL` as the default for `hub serve`; an explicit
`--public-url` still takes precedence. Run both the hub and connector under the
platform's service manager so they restart after login or reboot.

The hub creates the first `Flock Works` project automatically. Open the web app,
choose **Computers**, enter an agent name, and create a single-use enrollment
token.

For active/passive high availability, run a second hub against the same shared
data directory. The filesystem leader lock permits exactly one writer; standby
nodes report `503` from `/readyz` until they acquire leadership.

## Install an agent

Run the generated one-line command on the computer that should host the agent:

```bash
npx --yes @flock-works/flock@latest agent install --hub "https://flock.example.com" --enrollment "enr_…" --workspace "."
```

This exchanges the one-time token, writes the agent credential with owner-only
permissions, and installs a persistent user service. The same command works in
macOS and Linux shells, Windows Command Prompt, and PowerShell:

- macOS: LaunchAgent
- Linux: systemd user service
- Windows: Task Scheduler login task

The default model is `anthropic/claude-sonnet-4-6`. Provider credentials stay on
the agent machine and are resolved by `pi-ai`, for example
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or the provider’s supported ambient
credentials. Flock also reuses the protected credentials in
`~/.pi/agent/auth.json`, including an existing OpenAI Codex login. Override the
model with `--model provider/model-id`.
For a background service, put provider keys in an owner-only file such as
`~/.config/flock/provider.env` (`chmod 600`) and add
`--env-file ~/.config/flock/provider.env` to the install command. Flock loads
that file inside the service process without sending its contents to the hub.

Useful lifecycle commands:

```bash
npx --yes @flock-works/flock@latest agent status
npx --yes @flock-works/flock@latest agent stop
npx --yes @flock-works/flock@latest agent start
npx --yes @flock-works/flock@latest agent uninstall
```

`uninstall` removes only the service. It keeps the protected agent identity and
session mirror.

## Host agents on the hub

Hosted agents are optional and require Docker Engine. Build the runtime image:

```bash
npm run build:agent-image
```

Enable the feature with a dedicated 32-byte encryption key. The key protects
OAuth credentials and hosted-agent bearer tokens in `control.sqlite` and must
remain stable across restarts and HA nodes:

```bash
export FLOCK_HOSTED_AGENT_CREDENTIAL_KEY="$(openssl rand -base64 32)"
export FLOCK_HOSTED_AGENT_INTERNAL_HUB_URL="https://flock.example.com"
export FLOCK_NOUS_CLIENT_ID="your-nous-issued-flock-client-id"
flock hub serve --hosted-agents --data /srv/flock --listen 0.0.0.0:4747 --public-url https://flock.example.com
```

For a loopback development hub, set the internal URL to
`http://host.docker.internal:4747`; the runtime adds the corresponding host
gateway mapping on Linux.

The **Computers** page starts with a guided Nous Portal flow. A member clicks
**Create an agent on this hub**, approves the device-code login in Nous Portal,
searches the models available to that account, names the agent, and installs
it on the hub. `FLOCK_NOUS_CLIENT_ID` must be a client ID issued for Flock;
Flock does not reuse another application's public OAuth client. The optional
`FLOCK_NOUS_PORTAL_URL` and `FLOCK_NOUS_INFERENCE_URL` overrides are intended
for staging and testing and default to Nous production.

Nous access and refresh tokens remain encrypted in `control.sqlite`. The
container receives only its Flock agent credential and requests short-lived
provider access from the hub; no permanent Nous key is written to its mounted
configuration. Anthropic, OpenAI Codex, GitHub Copilot, and OpenRouter remain
available under **Advanced providers**.

Each hosted agent receives a durable empty workspace under
`hosted-agents/<agent-id>/workspace`. The assigned account and owner are
visible to project members because any member may dispatch work that consumes
that account.

Runtime settings can be adjusted with:

- `FLOCK_HOSTED_AGENT_IMAGE` (default `flock-agent:latest`)
- `FLOCK_HOSTED_AGENT_CPUS` (default `1`)
- `FLOCK_HOSTED_AGENT_MEMORY_MB` (default `2048`)
- `FLOCK_HOSTED_AGENT_PIDS` (default `256`)
- `FLOCK_HOSTED_AGENT_RETENTION_DAYS` (default `7`)

Containers have a read-only root filesystem, no Linux capabilities, no inbound
ports, explicit CPU/memory/PID limits, and mounts only for their protected
configuration, private state, and workspace. Deleting an agent removes its
container immediately and purges its retained workspace after the configured
recovery window.

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

`npm run dev:hub` uses a loopback-only development identity so the complete
landing page, API, and workspace can be exercised locally without production
OAuth credentials. Google sign-in is used when the hub starts without
`--dev-auth` and the production OIDC environment is configured.

The test suite checks upstream Pi JSONL compatibility, tree branches and cursors,
torn-tail repair, enrollment and authentication, dispatch leasing and stale
epochs, leader exclusion, exact agent mirroring, tool execution, non-replaying
recovery, service definitions, the production build, and rendered HTML.
