# DNS Resolution Observatory

An interactive DNS resolution simulator. It shows a lookup travelling from the client through the cache, recursive resolver, root, TLD and authoritative servers. You can watch it on a 3D globe (React Three Fiber) or a node graph (React Flow). Structured events from a separate Node.js TCP service drive both views.

## Architecture

```
Browser ──fetch NDJSON stream──▶ Next.js /api/resolve ─┐
        ──POST──────────────────▶ Next.js /api/control ─┤ one persistent, multiplexed TCP socket
                                                        ▼
                                    server/ (Node TCP service, port 7053)
                                      └─ in-memory zone hierarchy, documentation IPs only
```

- `src/shared/dns.ts` holds the event and protocol types plus domain validation. The server, the gateway and the UI all share it.
- `server/` contains the TCP service (`index.ts`), iterative resolver and TTL cache (`resolver.ts`), and the simulated transport (`transport.ts`).
- `src/server/dnsGateway.ts` and `src/app/api/*` form the Next.js gateway. It holds one reused TCP connection and streams one NDJSON response per query.
- `src/lib/dns/visuals.ts` maps each event to node states, edge labels and colours. `src/lib/dns/geo.ts` holds the illustrative globe locations.
- `src/hooks/useDnsResolver.ts` handles streaming, stale-result protection and event playback (one backend event per step, never overlapping), plus history and stats.
- `src/components/dns/` contains the dashboard, graph, panels and `globe/` (Earth shaders, markers, arcs, particles, WebGL fallback).

## Run

```bash
npm install
npm run dev          # TCP DNS service + Next.js dev server -> http://localhost:3000
# or separately:
npm run dns-server   # TCP service on 127.0.0.1:7053 (DNS_TCP_HOST / DNS_TCP_PORT to change)
npm run dev:web
# production
npm run build && npm run start:prod   # see Deploy below
```

Everything runs offline; no DNS packets leave the machine.

## Test

```bash
npm test             # protocol-level tests over TCP
npm run typecheck
npm run lint
npm run build
```

Simulation scenarios: `example.com` (cache miss, then hit), `www.example.com` (CNAME then restart), `wiki.org AAAA`, `glueless.org` (glueless delegation), `acme-shop.com AAAA` (NODATA), `nope.example.com` (NXDOMAIN), and `www.deadzone.io` (authoritative timeout). Use **Flush cache** to force a full walk again.

Any other domain also resolves. The service builds a delegation chain for it (root, TLD, an extra step for suffixes like `co.uk`, then the domain itself) and gives it its own address. The first lookup of a name assigns the next free IPv4 address (`203.0.113.100`-`.254`, then `198.18.0.0/15`) and IPv6 address (`2001:db8:a::/64`), and appends it to `data/sim-domains.csv` (`domain,ipv4,ipv6`). Later lookups, including after a restart, return the same addresses.

The CSV ships with about 1000 popular domains (from the [Tranco](https://tranco-list.eu) ranking) and a snapshot of their real public IPv4 and IPv6 addresses, looked up once through 1.1.1.1 / 8.8.8.8. An empty `ipv6` column means the domain has no AAAA record, so an AAAA query answers NODATA. The snapshot is not refreshed automatically; real sites change addresses over time. Edit a row to pin your own addresses, or delete the file to start over. Set `DNS_SIM_CSV` to use a different file.

## Deploy

By default the app is two processes: the Next.js web server and the DNS TCP service it talks to over a persistent socket, on the same host. Use any host that runs a long-lived container or Node process: Docker/Compose, Fly.io, Railway, Render, a VPS, Kubernetes, ECS and so on.

### Vercel (embedded mode)

Serverless platforms cannot run the separate TCP service, so on Vercel the resolver runs inside the API functions instead (`DNS_MODE=embedded`, the default when `VERCEL` is set). It uses the same protocol handling (`server/session.ts`) and resolver; only the socket hop is skipped. Import the repo in Vercel with the default Next.js settings; nothing else is needed.

Trade-offs: each function instance keeps its own cache, and it is lost when the instance is recycled, so cache hits can look inconsistent between requests. The filesystem is read-only, so newly generated domain assignments live in memory only; the shipped `data/sim-domains.csv` is still loaded. Set `DNS_MODE=tcp` or `DNS_MODE=embedded` to override the automatic choice anywhere.

### Docker (recommended)

```bash
docker compose up -d --build        # http://localhost:3000
# or
docker build -t dns-observatory .
docker run -d -p 3000:3000 -v dns-data:/app/data dns-observatory
```

The image runs `scripts/start-prod.mjs`, a small supervisor that starts the bundled DNS service (`dist/dns-server.mjs`, loopback only) and the Next.js standalone server (`server.js`). If either process exits, the container exits too, so the platform restarts it. The process runs as the unprivileged `node` user. Mount `/app/data` as a volume to keep generated domain assignments across restarts; the image seeds it with the shipped CSV.

### Render

`render.yaml` is a Render Blueprint that builds the Dockerfile as one web service with `/api/health` as its health check.

1. Push the repo to GitHub/GitLab.
2. In Render: **New → Blueprint**, pick the repo, and apply. (Or **New → Web Service**, runtime **Docker**, health check path `/api/health`.)
3. Custom domain: in the service's **Settings → Custom Domains**, add your domain and create the CNAME record Render shows (pointing at `<service>.onrender.com`). Remove any old record pointing at another host.

The `starter` plan stays awake; `free` works but sleeps after 15 minutes idle. To keep generated domain assignments across deploys, uncomment the `disk` block (paid plans).

### Without Docker

```bash
npm ci
npm run build        # next build (standalone) + bundles the DNS service + copies static assets
npm run start:prod   # needs only Node >= 20.9, not dev dependencies at runtime
```

### Configuration

All settings are environment variables; see `.env.example`. The main ones are `PORT` (default 3000), `HOSTNAME`, `DNS_TCP_HOST`/`DNS_TCP_PORT` (internal service; keep it on loopback), `DNS_MAX_INFLIGHT` (site-wide concurrent lookups, default 64), `DNS_SIM_CSV`, and `DNS_SIM_MAX_DOMAINS` (cap on stored generated names, default 20000).

### Health check

`GET /api/health` returns `200 {"ok":true,...}` when the web server can reach the DNS service and `503` otherwise. The Docker image uses it as its `HEALTHCHECK`; point your load balancer at it too.

Put a TLS-terminating proxy or the platform's HTTPS in front. The app sends HSTS and other security headers. `/api/resolve` streams NDJSON, so turn off response buffering on any proxy (the route already sends `X-Accel-Buffering: no` for nginx).

## Accuracy notes

- Simulated answers use the RFC 5737 / RFC 3849 documentation ranges and are labelled as a simulation.
- Globe positions are illustrative. Root and many TLD/authoritative servers are anycast, and an IP address does not reveal a server's physical location. Arcs show which server the resolver talks to, not the route packets take.
- The resolver caches final answers (including negative answers) by TTL. It does not cache delegations, so every cache miss walks from the root, which keeps the full referral chain visible.