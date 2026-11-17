# DNS Resolution Observatory: Project Explanation

This document explains how the project works from start to end: what happens when a user enters a domain, how the IP address is found, and which technology is used for which feature.

## 1. What this project is

The project is an interactive DNS simulator. You type a domain, and it shows the lookup travelling step by step through the DNS hierarchy, on a 3D globe or a 2D graph, until an IP address comes back.

**It is a simulation.** No real DNS packets leave the machine:

- The resolver logic is realistic: cache check, root, TLD, authoritative, referrals, CNAMEs, TTLs and failures.
- The "DNS servers" are objects in memory, and their network delay is an artificial 25–85 ms.
- The final IP comes from hand-written records or from a CSV file, `data/sim-domains.csv` ([section 5](#5-where-the-ip-address-actually-comes-from)).
- A domain that is not in the CSV gets a made-up address, even if it doesn't exist on the real internet.

## 2. The big picture

Three parts run together, and `npm run dev` starts the Next.js app and the DNS service as two processes:

```
┌───────────────────────┐
│  BROWSER (React)      │  Form, globe, graph, result and log panels
└──────────┬────────────┘
           │  HTTP: GET /api/resolve  → streamed response (NDJSON)
           │        POST /api/control → ping / flush cache
┌──────────▼────────────┐
│  NEXT.JS SERVER       │  API routes + gateway (one shared TCP connection)
└──────────┬────────────┘
           │  TCP on 127.0.0.1:7053, one JSON message per line
┌──────────▼────────────┐
│  DNS TCP SERVICE      │  server/  (separate Node.js process)
│   ├ Resolver + cache  │  Walks root → TLD → authoritative
│   ├ simTransport      │  The fake DNS servers, in memory
│   └ ipRegistry        │  Reads and appends data/sim-domains.csv
└───────────────────────┘
```

| Part | Main files | Job |
|---|---|---|
| Browser | `src/components/dns/`, `src/hooks/useDnsResolver.ts` | Takes input, reads the event stream, animates it |
| Next.js server | `src/app/api/`, `src/server/dnsGateway.ts` | Bridges browser HTTP to the TCP service |
| DNS service | `server/` | Does the resolving and emits an event for each step |
| Shared | `src/shared/dns.ts` | Types, wire protocol and domain validation used by all three |

**The key idea:** the backend doesn't send only a final answer. It sends a stream of events, one for each step of the lookup, and the whole UI is drawn from those events.

## 3. The complete flow: from domain to IP

This section follows `github.com`, record type `A`, with an empty cache.

### Step 0: Before the user types

1. `npm run dev` uses `concurrently` to start the TCP service on port 7053 and the Next.js server on port 3000.
2. `src/app/page.tsx` renders `Dashboard`.
3. `Dashboard` calls `POST /api/control` with `{action: "ping"}`. The service replies `pong`, and the header shows **DNS service connected**. If it can't connect, a red banner tells you how to start the service.

### Step 1: The user submits the form (browser)

`submit()` in `Dashboard.tsx` runs `normalizeDomain()` from `src/shared/dns.ts`, which:

- trims the input, lowercases it and removes a trailing dot
- rejects spaces, URLs (`https://...`) and characters like `/ @ : ? #`
- converts international names to punycode
- checks the total length (253 characters at most) and each label's format
- rejects anything whose last label is all digits, such as an IP address

If the input is invalid, an error appears under the box and nothing is sent. If it is valid, `dns.resolve("github.com", "A")` is called.

### Step 2: The browser opens a stream (browser)

`resolve()` in `useDnsResolver.ts`:

1. **Cancels any previous lookup** through its `AbortController`.
2. **Gives this run a new `id`.** Late updates from older runs carry an old id and are dropped.
3. **Sends the request:**

```
GET /api/resolve?domain=github.com&type=A
```

### Step 3: The API route starts the query (Next.js)

`src/app/api/resolve/route.ts`:

1. Creates a short random query ID (`qid`).
2. Subscribes to events for that `qid`.
3. Starts a 20-second safety timer.
4. Asks the gateway to send the query.
5. Returns a streaming `Response` without waiting for the answer, with content type `application/x-ndjson`.

If the browser disconnects, the route tells the service to cancel the query.

### Step 4: The gateway sends it over TCP (Next.js)

`src/server/dnsGateway.ts` keeps **one persistent TCP connection**, shared by all queries. It writes one line of JSON:

```json
{"t":"resolve","qid":"a52ec96a","domain":"github.com","qtype":"A"}
```

Replies come back on the same socket, mixed together, and the gateway routes each one to the right request using its `qid`. The instance is stored on `globalThis`, so dev hot reloads don't leak sockets.

### Step 5: The TCP service validates it (DNS service)

`server/index.ts` splits incoming data into lines, parses the JSON and checks the request again, because the service doesn't trust its callers:

| Check | Error code if it fails |
|---|---|
| `qid` present and not a duplicate | `BAD_REQUEST` |
| Type is `A` or `AAAA` | `UNSUPPORTED_TYPE` |
| Domain passes `normalizeDomain()` | `INVALID_DOMAIN` |
| Fewer than 8 queries in flight on this connection | `BUSY` |

It then calls `resolver.resolve(...)`. Each event the resolver emits is written back to the socket as a JSON line.

### Step 6: The resolver checks its cache (`server/resolver.ts`)

```
QUERY_STARTED → CACHE_CHECK → CACHE_HIT or CACHE_MISS
```

The cache is an in-memory map keyed by `name|type`, for example `github.com|A`.

- **Hit, with TTL remaining:** the lookup ends here, and no root, TLD or authoritative server is contacted.
- **Miss:** the resolver starts walking the tree from the root.

### Step 7: The resolver walks the DNS tree

`Resolver.iterate()` is a loop. It starts with `zone = "."` and the two root servers, then asks each server in turn:

**Ask the root**

```
Q: Where is github.com?
A: I don't know, but .com is served by a.sim-tld-com.invalid (198.51.100.1)
   → ROOT_REFERRAL
```

**Ask the TLD server**

```
Q: Where is github.com?
A: I don't know, but github.com is served by ns1.github.com (192.0.2.231)
   → TLD_REFERRAL
```

**Ask the authoritative server**

```
Q: What is the A record for github.com?
A: 20.207.73.82, TTL 300 seconds
   → DNS_RESPONSE
```

For each step, `iterate()` looks at the reply and does one of these:

| The reply contains | What the resolver does |
|---|---|
| A record of the requested type | **Done:** returns the answer |
| A `CNAME` (alias) | Records it, then restarts at the root with the new name |
| `NS` records for a closer zone (a referral) | Moves to those servers and loops again |
| `NXDOMAIN` | Stops: the name doesn't exist |
| An authoritative reply with no answer | Stops: `NODATA`, the name exists but has no record of this type |
| Any other error or invalid referral | Stops: `SERVFAIL` or `REFUSED` |

`ask()` sends each individual query. It shuffles the zone's servers, tries up to 3 of them and gives each 2 seconds. In a real resolver this would be a network call; here, `simTransport.query()` answers from memory after the artificial delay.

### Step 8: The simulated server answers (`server/transport.ts`)

On each query, `simTransport.query()`:

1. **`ensureZones(name)`** creates any missing zones so the name has a path from the root. For `github.com` it makes sure the `github.com` zone exists under `com`. For `www.bbc.co.uk` it builds `uk → co.uk → bbc.co.uk`.
2. **`findZone(ip, name)`** works out which zone this server IP serves.
3. If the zone has a matching child, it **returns a referral**: NS records plus glue (the name servers' IP addresses).
4. Otherwise it is the authoritative server, so it **calls `generateRecords()`**. That is where the final IP comes from ([section 5](#5-where-the-ip-address-actually-comes-from)).

### Step 9: The answer is cached and returned

```
CACHE_STORE → QUERY_COMPLETED ("Final answer: 20.207.73.82")
```

The cache TTL is the lowest TTL among the answer's records. `QUERY_COMPLETED` carries the full result:

```json
{
  "domain": "github.com", "qtype": "A", "status": "NOERROR",
  "addresses": ["20.207.73.82"], "ttl": 300, "cached": false, "durationMs": 167.6
}
```

### Step 10: The events travel back

```
Resolver → TCP socket → gateway (routes by qid) → API route stream → browser fetch reader
```

The hook decodes the stream, splits it into lines, parses each line and adds the events to `run.events`. When the route sees `QUERY_COMPLETED`, `QUERY_FAILED` or an error, it closes the stream.

### Step 11: The browser plays the events slowly

The real lookup takes about 170 ms, which is too fast to watch. The hook therefore separates **receiving** from **showing**:

- `run.events` holds everything received so far.
- `cursor` says how many events have been shown.
- A timer moves `cursor` forward one event every 900 ms at 1× speed (speeds are 0.5×, 1×, 2× and 4×).
- `played` is `events.slice(0, cursor)`, and everything on screen is drawn from it.

This is why an 11-event lookup takes about 9 seconds to watch even though it finished in under 200 ms. **Replay** only sets `cursor` back to 0; it doesn't query the service again.

### Step 12: Events become visuals

`deriveJourney(played)` in `src/lib/dns/visuals.ts` converts the played events into one state object: each node's status, the active edge, the visited edges and the result. A single table, `RULES`, defines each event type's colour, stage title, explanation, edge label and node states.

| Colour | Meaning |
|---|---|
| Blue | Outgoing DNS query |
| Purple | Referral or CNAME |
| Green | Successful response |
| Amber | Processing or cache miss |
| Red | Failure or timeout |

The globe, graph, journey bar, stage panel and event log all read from this same data, so they stay in step.

### Step 13: The IP appears on screen

When playback reaches `QUERY_COMPLETED`:

- The **Result** panel shows `20.207.73.82` with its status, TTL and duration.
- A row is added to **Query history**, and **Query statistics** update.

The result appears when the animation reaches it, not when the backend finished.

## 4. Real traces from this code

These were captured by running the real TCP service against a temporary copy of the CSV. Server choices and timings vary between runs.

**Cache miss: 11 events, 167.6 ms**

```
 0 QUERY_STARTED       client   -> resolver  Client asks resolver for github.com A
 1 CACHE_CHECK         resolver -> cache     Resolver checks its cache for github.com/A
 2 CACHE_MISS          cache    -> resolver  No valid cached record, starting iterative resolution at the root
 3 ROOT_QUERY          resolver -> root      Resolver asks root server b.sim-root.invalid (192.0.2.2) for github.com A
 4 ROOT_REFERRAL       root     -> resolver  b.sim-root.invalid refers resolver to .com name servers [27ms]
 5 TLD_QUERY           resolver -> tld       Resolver asks TLD server a.sim-tld-com.invalid (198.51.100.1) for github.com A
 6 TLD_REFERRAL        tld      -> resolver  a.sim-tld-com.invalid refers resolver to github.com name servers [60ms]
 7 AUTHORITATIVE_QUERY resolver -> auth      Resolver asks authoritative server ns1.github.com (192.0.2.231) for github.com A
 8 DNS_RESPONSE        auth     -> resolver  ns1.github.com returns 1 A record(s) for github.com [78ms]
 9 CACHE_STORE         resolver -> cache     Resolver caches answer for 300s
10 QUERY_COMPLETED     resolver -> client    Final answer: 20.207.73.82
```

**Same query again, cache hit: 4 events, 0.3 ms**

```
 0 QUERY_STARTED       client   -> resolver  Client asks resolver for github.com A
 1 CACHE_CHECK         resolver -> cache     Resolver checks its cache for github.com/A
 2 CACHE_HIT           cache    -> resolver  Cache hit (NOERROR), 300s TTL remaining
 3 QUERY_COMPLETED     resolver -> client    Answer served from cache: 20.207.73.82
```

## 5. Where the IP address actually comes from

The authoritative step picks the answer using these rules, in order:

| # | Case | Example | Result |
|---|---|---|---|
| 1 | Reserved TLD (`.invalid`, `.test`, `.localhost`, `.example`) | `foo.invalid` | The root answers `NXDOMAIN` |
| 2 | Hand-written zone in `transport.ts` | `example.com` | Fixed record: `192.0.2.10` |
| 2a | Name not listed in a hand-written zone | `nope.example.com` | `NXDOMAIN` |
| 3 | `www.` + a generated domain | `www.bbc.co.uk` | `CNAME` to `bbc.co.uk`, then restart at the root |
| 4 | Name is in the CSV | `github.com` | The address in its row: `20.207.73.82` |
| 5 | Name is not in the CSV | any new name | Next free address, **saved to the CSV** |

**About `data/sim-domains.csv`**

```csv
domain,ipv4,ipv6
github.com,20.207.73.82,
google.com,192.178.211.139,2404:6800:4000:1025::64
```

- It ships with about 1000 popular domains and a one-time snapshot of their real public IPs. The snapshot is not refreshed, so some addresses may be out of date.
- An empty `ipv6` column means no AAAA record, so `github.com AAAA` answers `NODATA`.
- New names get the next free IPv4 address (`203.0.113.100`–`.254`, then `198.18.0.0/15`) and IPv6 address (`2001:db8:a::/64`). These are reserved ranges, not real hosts.
- Saved rows survive restarts, so a name keeps its address. This also means typos stay in the file permanently.
- Each full name gets its own row, so `mail.github.com` receives its own new address rather than GitHub's.
- You can edit a row by hand to pin an address, or set `DNS_SIM_CSV` to use a different file.

**The fake servers' IPs are not the answer.** Addresses like `192.0.2.231` belong to simulated name servers and are generated from a hash of the zone name. Only the address in the final answer is the "resolved IP".

## 6. Other paths through the flow

| Scenario | Try | What happens | Status |
|---|---|---|---|
| CNAME | `www.example.com` | Alias found, walk restarts at the root (17 events) | `NOERROR` |
| Extra delegation | `www.bbc.co.uk` | Adds an `AUTHORITATIVE_REFERRAL` for `co.uk` | `NOERROR` |
| Glueless delegation | `glueless.org` | Referral has no NS address, so the resolver looks it up first | `NOERROR` |
| Name doesn't exist | `nope.example.com` | Negative answer, cached for 60 s | `NXDOMAIN` |
| No record of that type | `acme-shop.com AAAA` | Negative answer, cached for 60 s | `NODATA` |
| Server never replies | `www.deadzone.io` | Times out after 2 s, and the auth node turns red | `TIMEOUT` |
| Invalid input | `bad domain` | Stopped in the browser, with no request sent | Inline error |
| Service is down | stop the TCP service | Route streams an error, and a red banner appears | `BACKEND_UNAVAILABLE` |

Two details:

- **The glueless lookup is hidden.** It runs with events switched off, so the extra time appears only in the duration: about 307 ms in the trace, while the visible steps add up to about 183 ms.
- **Only definite answers are cached.** `NOERROR`, `NXDOMAIN` and `NODATA` are stored; timeouts and server failures are not, so they are retried next time.

### Safety limits

| Limit | Value |
|---|---|
| Timeout per server | 2 s |
| Deadline per query | 15 s |
| Stream timeout in the API route | 20 s |
| Servers tried per step | 3 |
| Steps per walk | 24 |
| CNAMEs followed | 8 |
| Nested name-server lookups | 3 |
| Cache size | 2000 entries (oldest inserted is removed first) |
| Maximum TTL | 86400 s (1 day) |
| Queries in flight per connection | 8 |

## 7. Tech stack: what is used for which feature

### Frontend

| Technology | Used for | Where |
|---|---|---|
| **Next.js 16** (App Router, Turbopack) | Page, API routes, dev server and build | `src/app/` |
| **React 19** | All UI, state and playback logic | `src/components/`, `src/hooks/` |
| **TypeScript** | Types across all three layers | Everywhere |
| **Tailwind CSS v4** | Styling and the dark navy theme | `className`s, `globals.css` |
| **Three.js** | 3D engine: spheres, curves, vectors | `globe/` |
| **React Three Fiber** | Writes the Three.js scene as React components, with a per-frame loop | `GlobeScene.tsx`, `Network.tsx`, `Earth.tsx` |
| **Drei** | `OrbitControls` (drag/zoom), `Stars`, `Line` (arcs), `useTexture` | `globe/` |
| **GLSL shaders** | Day/night Earth, city lights, ocean glint, atmosphere glow | `Earth.tsx` |
| **React Flow** (`@xyflow/react`) | The 2D node graph | `DnsGraph.tsx` |
| **SVG `animateMotion`** | The dot moving along graph edges | `DnsGraph.tsx` |
| **Lucide React** | Icons | `Dashboard.tsx`, `ui.tsx` |
| **Geist** (`next/font`) | Sans and mono fonts | `layout.tsx` |

### Backend and communication

| Technology | Used for | Where |
|---|---|---|
| **Node.js `net`** | TCP service and the gateway's connection to it | `server/index.ts`, `dnsGateway.ts` |
| **NDJSON** (one JSON object per line) | Message format on both TCP and HTTP | `src/shared/dns.ts` |
| **Next.js Route Handlers** | `/api/resolve` and `/api/control` | `src/app/api/` |
| **Web Streams** (`ReadableStream`, `TextDecoderStream`) | Sending events to the browser as they happen | `route.ts`, `useDnsResolver.ts` |
| **`AbortController`** | Cancelling a lookup when a new one starts | `useDnsResolver.ts` |
| **JavaScript `Map`** | The TTL cache and the in-memory domain table | `resolver.ts`, `ipRegistry.ts` |
| **CSV + Node.js `fs`** | Saved domain-to-IP assignments (there is no database) | `ipRegistry.ts` |

### Tooling

| Technology | Used for |
|---|---|
| **tsx** | Running the TypeScript service directly, with auto-restart in dev |
| **concurrently** | Starting the service and Next.js with one command |
| **`node:test`** | Integration tests over the real TCP protocol |
| **ESLint** | Linting |

### Feature to technology

| Feature | Technology | Main file |
|---|---|---|
| Domain validation | TypeScript, URL parser | `src/shared/dns.ts` |
| Live step-by-step updates | NDJSON over a streamed response | `api/resolve/route.ts` |
| Iterative resolving | TypeScript class | `server/resolver.ts` |
| Fake DNS hierarchy | In-memory zone tree | `server/transport.ts` |
| TTL cache | `Map` with expiry times | `server/resolver.ts` |
| Saved IP addresses | CSV file | `server/ipRegistry.ts` |
| Animation playback and speed | React state and timers | `useDnsResolver.ts` |
| Event-to-visual mapping | One rule table | `src/lib/dns/visuals.ts` |
| 3D Earth | Three.js, React Three Fiber, GLSL | `globe/Earth.tsx` |
| Arcs, markers, moving particle | Three.js, Drei | `globe/Network.tsx` |
| Camera, rotation, zoom | Drei `OrbitControls` | `globe/GlobeScene.tsx` |
| Map locations | Lookup tables and a hash | `src/lib/dns/geo.ts` |
| 2D graph | React Flow, SVG | `DnsGraph.tsx` |
| Result, log, history, stats | React, Tailwind | `ui.tsx` |

## 8. The two views

Both views draw the same `journey` data. The tabs only change how it is displayed.

### 3D globe

- **Earth:** a sphere using day, night and ocean textures from `public/textures/`, plus a cloud layer and an atmosphere glow.
- **Locations:** `placeNodes()` in `geo.ts` gives each node a place, based on the selected client city.
- **Arcs:** `arcCurve()` in `math.ts` draws a curve between two points, rising higher over longer distances.
- **Labels:** these are HTML elements, repositioned every frame and faded out when they go behind the globe.

**Locations are illustrative.** They don't show where any server really is. Root and many other DNS servers are anycast, and an IP address doesn't reveal a physical location. The arcs show who talks to whom, not the route packets take.

Fallbacks:

| Problem | What happens |
|---|---|
| Globe code on the server | It loads only in the browser (`next/dynamic` with `ssr: false`) |
| No WebGL, or WebGL context lost | Switches to the 2D graph with a notice |
| Textures still loading or failed | Shows a plain blue globe |

### 2D graph

Six fixed nodes: Client, Recursive Resolver, DNS Cache, Root, TLD and Authoritative. The active edge is coloured and labelled, with a moving dot; visited edges stay faintly coloured.

## 9. History, statistics and persistence

A lookup is added to history when its final event has been **played**, or immediately on a stream error. If you start a new lookup during playback, the previous one isn't recorded. Replays aren't counted twice.

| Data | Stored in | Cleared by |
|---|---|---|
| History and statistics (last 50 lookups) | Browser memory | Refreshing the page |
| Resolver cache | TCP service memory, shared by all tabs | **Flush cache**, TTL expiry or restarting the service |
| Domain-to-IP assignments | `data/sim-domains.csv` | Editing or deleting the file |

## 10. Running and testing

```bash
npm install
npm run dev          # TCP service + Next.js → http://localhost:3000

npm run dns-server   # Only the TCP service
npm run dev:web      # Only Next.js

npm run build && npm start   # Production

npm test             # Integration tests over TCP
npm run typecheck
npm run lint
```

| Environment variable | Default | Purpose |
|---|---|---|
| `DNS_TCP_HOST` | `127.0.0.1` | TCP service host |
| `DNS_TCP_PORT` | `7053` | TCP service port |
| `DNS_SIM_CSV` | `data/sim-domains.csv` | Domain-to-IP file |

## 11. File map

```
server/
  main.ts              Starts the TCP service
  index.ts             TCP server: parses messages, validates, enforces limits
  resolver.ts          Iterative resolver and TTL cache
  transport.ts         Simulated DNS servers and zone tree
  ipRegistry.ts        Reads and appends the CSV
  resolver.test.ts     Integration tests

src/
  shared/dns.ts        Types, protocol, normalizeDomain()
  server/dnsGateway.ts Shared TCP connection from Next.js
  app/
    layout.tsx         Fonts and page metadata
    page.tsx           Renders the Dashboard
    globals.css        Theme and animations
    api/resolve/       Streams the events for one query
    api/control/       Ping and flush
  hooks/
    useDnsResolver.ts  Streaming, playback, history, statistics
  lib/dns/
    visuals.ts         RULES table, deriveJourney()
    geo.ts             Illustrative locations
  components/dns/
    Dashboard.tsx      Main screen and search form
    DnsGraph.tsx       2D graph
    ui.tsx             Result, log, history, stats, legend
    globe/
      GlobeView.tsx    WebGL check and fallback
      GlobeScene.tsx   Canvas, lights, camera
      Earth.tsx        Earth shaders and textures
      Network.tsx      Markers, arcs, particle, labels
      math.ts          Lat/lon conversion and arc curves

data/sim-domains.csv   About 1000 domains and their IPs
public/textures/       Earth images
```

## 12. Summary

1. The user enters a domain, and the browser validates it.
2. The browser opens a streaming request to `/api/resolve`.
3. Next.js forwards the query over one shared TCP connection.
4. The TCP service validates it again and checks the cache.
5. On a hit, it answers immediately.
6. On a miss, it asks the root, then the TLD, then the authoritative server, following each referral.
7. The authoritative server's answer comes from a hand-written record or the CSV; a new name gets a new address, which is saved.
8. The answer is cached for its TTL.
9. Every step is streamed back to the browser as an event.
10. The browser replays those events slowly on the globe or graph, then shows the IP.
