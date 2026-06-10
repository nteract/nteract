# Notebook Cloud EC2 fallback

This is the lowest-churn way to run the hosted notebook prototype when
`preview.runt.run` is unavailable or rate-limited. It does **not** introduce a
second room-host implementation. It runs the existing Cloudflare Worker bundle
locally through Wrangler/Miniflare on one EC2 instance, with persisted local
Durable Object, D1, and R2-compatible state.

Use this for demos and recovery drills. It is not the long-term production
topology.

## Shape

```text
browser
  |
  | HTTPS / WebSocket
  v
EC2 reverse proxy
  |
  | http://127.0.0.1:8787
  v
wrangler dev --local --persist-to /var/lib/nteract/notebook-cloud
  |
  +- NotebookRoom Durable Objects in local Miniflare state
  +- D1 catalog/sharing/workstation tables in local Miniflare state
  +- R2-like snapshot/blob objects in local Miniflare state
  +- built viewer/runtime/renderer assets from apps/notebook-cloud/dist
```

The EC2 wrapper deliberately overrides preview-specific asset URLs so the
viewer uses same-origin `/assets/` and `/renderer-assets/` paths. The isolated
output document origin falls back to the browser `srcdoc` path unless you run a
separate output-origin service.

## Build

From the repository checkout on EC2:

```bash
pnpm install
pnpm --dir apps/notebook-cloud run build
```

Build first. The EC2 wrapper starts the Worker runtime; it does not rebuild
viewer/WASM assets on every process start.

## Browser auth for fallback demos

OIDC login requires a redirect URI registered for the public EC2 origin. Until
that exists, use the existing prototype dev-token flow for human browser access.
The token is sent in first-party headers/WebSocket subprotocols, not in URLs.

Generate a token and keep it out of git:

```bash
install -d -m 700 ~/.config/nteract
printf "NOTEBOOK_CLOUD_DEV_TOKEN=%s\n" "$(openssl rand -base64 32)" \
  > ~/.config/nteract/notebook-cloud-ec2.env
chmod 600 ~/.config/nteract/notebook-cloud-ec2.env
```

Open `https://<host>/?dev_auth=1`, enter the token, choose the user/scope for
the demo, then open `/n`.

API-key auth still works for workstation runners and scripts. Put the existing
Anaconda API key in the environment used by those processes; do not place it in
the browser.

## Start manually

```bash
set -a
. ~/.config/nteract/notebook-cloud-ec2.env
set +a

NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN=https://notebooks.example.com \
NOTEBOOK_CLOUD_EC2_HOST=127.0.0.1 \
NOTEBOOK_CLOUD_EC2_PORT=8787 \
NOTEBOOK_CLOUD_EC2_PERSIST_TO=/var/lib/nteract/notebook-cloud \
pnpm --dir apps/notebook-cloud run dev:ec2
```

The wrapper runs:

- `wrangler dev --local`
- `--persist-to` so rooms/catalog/blob state survives restarts
- `DEPLOYMENT_ENV=ec2`
- `NOTEBOOK_CLOUD_ALLOWED_ORIGINS=<public origin>`
- same-origin renderer/runtime asset URLs
- OIDC disabled by default, so the prototype dev-token UI is visible

Set `NOTEBOOK_CLOUD_EC2_ENABLE_OIDC=1` only after the public origin's
`/oidc` redirect URI is registered with the identity provider. In that mode the
wrapper keeps the normal OIDC config and overrides only
`NOTEBOOK_CLOUD_OIDC_REDIRECT_URI` to `<public origin>/oidc` unless you set it
explicitly.

## Reverse proxy

Any proxy must support WebSocket upgrades. A minimal Caddy shape:

```caddyfile
notebooks.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

For nginx:

```nginx
server {
  listen 443 ssl;
  server_name notebooks.example.com;

  location / {
    proxy_pass http://127.0.0.1:8787;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
  }
}
```

## systemd unit

```ini
# ~/.config/systemd/user/nteract-notebook-cloud-ec2.service
[Unit]
Description=nteract notebook-cloud EC2 fallback
After=network-online.target

[Service]
WorkingDirectory=%h/codex/nteract
EnvironmentFile=%h/.config/nteract/notebook-cloud-ec2.env
Environment=NOTEBOOK_CLOUD_EC2_PUBLIC_ORIGIN=https://notebooks.example.com
Environment=NOTEBOOK_CLOUD_EC2_HOST=127.0.0.1
Environment=NOTEBOOK_CLOUD_EC2_PORT=8787
Environment=NOTEBOOK_CLOUD_EC2_PERSIST_TO=/var/lib/nteract/notebook-cloud
ExecStart=%h/.local/share/pnpm/pnpm --dir apps/notebook-cloud run dev:ec2
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

If `/var/lib/nteract/notebook-cloud` is owned by root, create it once and give
the EC2 user write access:

```bash
sudo install -d -o "$USER" -g "$USER" -m 700 /var/lib/nteract/notebook-cloud
```

## Workstation runner

Point the workstation runner at the EC2 origin:

```bash
set -a
. ~/preview.runt.run/.env   # provides NTERACT_API_KEY, if that is where it lives
set +a

NTERACT_CLOUD_URL=https://notebooks.example.com \
NOTEBOOK_CLOUD_WORKSTATION_ID=lab2 \
NOTEBOOK_CLOUD_WORKSTATION_DISPLAY_NAME="lab2 workstation" \
NOTEBOOK_CLOUD_WORKSTATION_CWD="$PWD" \
pnpm --dir apps/notebook-cloud smoke:hosted:workstation-agent
```

For manual demos, keep the workstation runner in tmux/systemd. Use API-key auth
for long-lived headless workstations.

## Smoke checks

Against the EC2 origin:

```bash
NTERACT_CLOUD_URL=https://notebooks.example.com \
NOTEBOOK_CLOUD_DEV_TOKEN=<token> \
pnpm --dir apps/notebook-cloud smoke

NTERACT_CLOUD_URL=https://notebooks.example.com \
NOTEBOOK_CLOUD_DEV_TOKEN=<token> \
pnpm --dir apps/notebook-cloud smoke:hosted:collab
```

Workstation/browser smokes can run after the workstation runner is online, but
they still need either a browser OIDC token cache or explicit dev-token setup
depending on the smoke.

## Limitations

- Single EC2 instance only. Local Durable Object state is not shared across
  machines, so do not run multiple active instances behind one load balancer.
- Local Miniflare persistence is a fallback store, not managed D1/R2. Back up
  the persist directory if the demo state matters.
- OIDC login needs a registered redirect URI for the EC2 origin. Without that,
  use prototype dev-token browser auth.
- The default EC2 wrapper uses same-origin renderer assets and `srcdoc` output
  frames. That is acceptable for a fallback demo, but it is not the same output
  origin isolation posture as `preview.runt.run` plus `preview.runtusercontent.com`.
- `wrangler dev` is a development runtime. This buys us independence from the
  Cloudflare daily Durable Object quota; it is not a substitute for the future
  Rust/Postgres room-host service.
