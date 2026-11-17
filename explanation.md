# How the DNS Resolution Observatory Works

This document follows one lookup from the moment you press **Resolve Domain** until the answer appears on screen. It also explains the job of each part of the codebase.

---

## 1. The big picture

The project is made of **three processes and layers** that talk to each other:

```
┌──────────────────────────┐  HTTP (streamed NDJSON)  ┌───────────────────────────┐   TCP (NDJSON)   ┌──────────────────────────────┐
│  Browser (React UI)      │ ───────────────────────▶ │  Next.js server (gateway) │ ───────────────▶ │  DNS TCP service (server/)   │
│  globe, graph, panels    │ ◀─────────────────────── │  /api/resolve, /api/control│ ◀─────────────── │  resolver + cache + transport│
└──────────────────────────┘     DNS events           └───────────────────────────┘    DNS events    └──────────────┬───────────────┘
                                                                                                                    │
                                                                         live mode: real UDP/TCP port 53            │  sim mode: in-memory
                                                                         root → TLD → authoritative servers ◀───────┘  fake hierarchy
```

| Layer | Where | Job |
|---|---|---|
| **DNS TCP service** | `server/` | Does the actual DNS resolution and emits one event per step |
| **Gateway** | `src/server/dnsGateway.ts`, `src/app/api/*` | Bridges the browser (HTTP) and the TCP service |
| **UI** | `src/components/dns/*`, `src/hooks/*`, `src/lib/dns/*` | Plays events back as animations, panels, logs and stats |
| **Shared contract** | `src/shared/dns.ts` | Types, event names and domain validation, used by all three layers |

Why a separate TCP service? The original requirement was to keep a Node.js TCP socket server as the networking component. Putting it in its own process also keeps the DNS logic completely independent of the UI and of Next.js.

---

## 2. A lookup, step by step

Say you search for `example.com` with type `A` in **Simulation** mode.

### Step 1: The browser validates and sends the request
`Dashboard.tsx` calls `normalizeDomain()` from `src/shared/dns.ts`. This function:
- trims the input, lowercases it and removes a trailing dot
- rejects spaces, URLs (`https://…`), IP addresses and invalid labels
- converts international names to punycode (`bücher.de` → `xn--bcher-kva.de`)

If the input is valid, `useDnsResolver().resolve()` runs:

```
GET /api/resolve?domain=example.com&type=A&mode=sim
```

Before it sends anything, it **aborts any previous request**. Starting a new search therefore cancels the old one, both in the browser and on the backend.

### Step 2: The gateway forwards the request over TCP
`src/app/api/resolve/route.ts`:
1. creates a short query ID (`qid`), e.g. `a52ec96a`
2. subscribes to events for that `qid`
3. sends one JSON line over the shared TCP socket:
   ```json
   {"t":"resolve","qid":"a52ec96a","domain":"example.com","qtype":"A","mode":"sim"}
   ```
4. streams every message it receives back to the browser, one JSON object per line (NDJSON)
5. closes the stream on `QUERY_COMPLETED`, `QUERY_FAILED`, an error, or a 20-second safety timeout

`dnsGateway.ts` keeps **one persistent TCP connection** and multiplexes all queries over it by `qid`. It does not open a new socket per request. If the connection drops, every waiting query gets a `BACKEND_UNAVAILABLE` error, and the next request reconnects.

### Step 3: The TCP service resolves the name
`server/index.ts` receives the line and checks the request again. It never trusts the client, and it rejects unsupported types such as `MX` with `UNSUPPORTED_TYPE`. It then hands the query to the `Resolver` for the chosen mode.

`server/resolver.ts` → `Resolver.resolve()` emits events as it works:

```
QUERY_STARTED      client → resolver     "Client asks resolver for example.com A"
CACHE_CHECK        resolver → cache
CACHE_MISS         cache → resolver      (nothing valid cached)
ROOT_QUERY         resolver → root       ask a root server
ROOT_REFERRAL      root → resolver       "go ask the .com servers"
TLD_QUERY          resolver → tld        ask a .com server
TLD_REFERRAL       tld → resolver        "go ask example.com's name servers"
AUTHORITATIVE_QUERY resolver → auth      ask example.com's server
DNS_RESPONSE       auth → resolver       "example.com A 192.0.2.10"
CACHE_STORE        resolver → cache      store for TTL seconds
QUERY_COMPLETED    resolver → client     final answer
```

Each event has the same shape (defined in `src/shared/dns.ts`):

```ts
{
  qid: "a52ec96a",        // which query
  seq: 4,                  // order within the query
  ts: 1760340000123,       // timestamp (ms)
  type: "ROOT_REFERRAL",   // what happened
  node: "resolver",        // where it arrives
  from: "root",            // who sent it (defines the edge to animate)
  msg: "b.sim-root.invalid refers resolver to .com name servers: …",
  data: { zone: "com", server: {...}, ns: [...], rttMs: 48 }   // only relevant fields
}
```

### Step 4: The UI plays the events back
Events can arrive very quickly: a cache hit takes under 1 ms, and a simulated miss takes about 200 ms. Nobody could follow that, so `useDnsResolver.ts` **queues** the events and plays them back **one at a time** (900 ms each at 1× speed):

```
received: [e0, e1, e2, … e10]      ← filled as the stream arrives
cursor:          ▲                 ← advances every STEP_MS / speed
played = received.slice(0, cursor) ← what the screen shows
```

Key points:
- The animation follows **the actual events the backend sent**, in order. It is not a pre-recorded script. If the backend sent a retry, a CNAME restart or a timeout, you see that.
- Only one run owns the cursor, so animations **never overlap**.
- Every update is tagged with a run ID. Late events from an older search are dropped, so **stale results never appear**.
- **Replay** just resets the cursor to 0 and plays the same recorded events again.

### Step 5: Events become visuals
`src/lib/dns/visuals.ts` holds a lookup table, `RULES`, with one entry per event type:

```ts
ROOT_REFERRAL: {
  kind: "referral",                       // → purple
  stage: "Root referral",                 // title in the stage panel
  explain: "The root replies with a referral …",
  label: (e) => `Referral: .${zone}`,     // text on the edge
  states: (e) => ({ root: "referral", resolver: "referral" }),  // node states
}
```

`deriveJourney(played)` folds all played events through this table and produces:
- `states`: the state of each node (idle, active, waiting, cache-hit, resolved, failed, …)
- `active`: which edge to animate, in which direction, with which colour and label
- `visited`: edges already used (drawn dimmer)
- `result`: the final answer, once the last event has played

**Both the graph and the globe read this same `Journey` object.** That is why the two views always agree with each other.

| Colour | Meaning (`kind`) |
|---|---|
| 🔵 Blue | outgoing DNS query |
| 🟣 Purple | referral / routing (and CNAME aliases) |
| 🟢 Green | successful response |
| 🟠 Amber | processing / cache miss |
| 🔴 Red | failure / timeout / NXDOMAIN |

---

## 3. How the resolver really resolves (backend detail)

### Iterative resolution (`Resolver.iterate`)
A real recursive resolver does not ask one server for the whole answer. It **walks down the DNS tree**:

```
start: zone = "."   servers = root hints (a.root-servers.net … m.root-servers.net)
loop:
  ask one server in the current zone for the name
  ├─ answer contains the record          → done (NOERROR)
  ├─ answer is a CNAME (alias)           → follow it: restart at the root for the target name
  ├─ NXDOMAIN / empty authoritative reply → done (NXDOMAIN / NODATA), cache the negative answer
  ├─ NS records for a closer zone        → REFERRAL: switch to those servers, go deeper
  │     └─ no glue IPs?                   → quietly look up the name server's address first
  └─ anything else                        → SERVFAIL (lame or invalid server)
```

Which node lights up depends on the zone being asked:
- zone `.` → **root**
- zone with one label (`com`, `uk`) → **TLD**
- anything deeper (`example.com`, `bbc.co.uk`) → **authoritative**

### Safety limits
| Limit | Value | Purpose |
|---|---|---|
| Per-server timeout | 2 s | try the next server if one is silent |
| Servers tried per step | 3 | random order, like real resolvers |
| Whole-query deadline | 15 s | never hang forever |
| Max steps / CNAME hops | 24 / 8 | prevent loops |

### The cache (`TtlCache`)
- The key is `name|type`, e.g. `example.com|A`.
- Each entry stores the status, the records and an expiry time (`now + TTL`). TTL is capped at 1 day.
- **Negative answers are cached too** (NXDOMAIN and NODATA), using the SOA minimum TTL, as real resolvers do.
- On a hit, the event reports the **remaining TTL** (for example "286s remaining").
- Live mode and sim mode have **separate caches**, so they never mix.
- **Flush cache** in the UI sends a `{"t":"flush"}` control message to clear one mode's cache.

### Two transports, one resolver
The resolver doesn't know whether it is talking to the real internet. It calls `transport.query(server, name, type)`, and `server/transport.ts` provides two implementations:

**`liveTransport`: real DNS**
- `server/wire.ts` builds a real DNS packet (RFC 1035, with the RD flag off for an iterative query, plus EDNS0).
- The packet goes over **UDP port 53** to the server's IP. Replies are accepted only from that IP and with the matching random ID.
- If the reply has the **TC (truncated)** bit set, the query is retried over **TCP**.
- `wire.ts` also decodes the reply: header, compressed names, A, AAAA, NS, CNAME and SOA records.
- It starts from the official IANA root server addresses.

**`simTransport`: simulation**
- A nested in-memory tree: root → `com`/`org`/`net`/`io` → domains.
- It uses only **documentation IP ranges** that can never be real (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`).
- It adds an artificial 25–85 ms delay so the timing feels realistic.
- It answers in the same message format as a real server, so the resolver code path is identical.
- Built-in test scenarios:

| Query | What it demonstrates |
|---|---|
| `example.com A` | normal miss → root → TLD → auth, then a cache hit |
| `www.example.com AAAA` | CNAME alias, resolver restarts at the root |
| `wiki.org AAAA` | IPv6 answer |
| `glueless.org A` | delegation without glue; name server address looked up first |
| `acme-shop.com AAAA` | NODATA (name exists, no IPv6 record) |
| `nope.example.com A` | NXDOMAIN |
| `www.deadzone.io A` | authoritative server never answers → TIMEOUT |

---

## 4. The wire protocol (control vs. events)

Both TCP and HTTP use **newline-delimited JSON**: one message per line. Control messages are kept separate from resolution events:

**Client → TCP service**
```json
{"t":"resolve","qid":"…","domain":"…","qtype":"A","mode":"live"}
{"t":"cancel","qid":"…"}            // browser aborted, so stop emitting
{"t":"flush","mode":"sim"}          // clear a cache
{"t":"ping"}                        // health check
```

**TCP service → client**
```json
{"t":"event","e":{ …DnsEvent… }}
{"t":"error","qid":"…","code":"INVALID_DOMAIN","msg":"…"}
{"t":"flushed","mode":"sim","removed":3}
{"t":"pong","version":1}
```

`/api/control` (POST) handles `ping` and `flush`. `/api/resolve` (GET) streams the events for one query.

---

## 5. The frontend views

### The dashboard (`Dashboard.tsx`)
- Header with the **Simulation / Live DNS** toggle and a "DNS service connected" indicator (from the `ping`).
- A banner that states clearly whether the results are simulated or real.
- The search bar, record type selector (A or AAAA), example chips and **Flush cache**.
- The **journey bar**: Client › Cache › Root › TLD › Authoritative › Answer. Steps that a cache hit skips are struck through.
- The visualization area with **3D Globe / Graph** tabs and a **stage panel** that explains the current step.
- Side panels: **Result**, **Statistics**, **Live event log**. Below them is the **Query history** table.

### The graph (`DnsGraph.tsx`, React Flow)
- Six custom nodes. Each has an icon, a label, a status dot and a one-line explanation.
- The layout is a star around the resolver, because in iterative DNS the **resolver talks to each server itself**.
- The active edge shows a dashed flowing line, a label (`Referral: .com`, `Final Answer`, …) and a glowing dot. The dot travels forward for queries and backward for responses.

### The globe (`globe/`)
| File | Role |
|---|---|
| `GlobeView.tsx` | Loads the 3D code only in the browser (`next/dynamic`, `ssr:false`). Checks for WebGL and falls back to the graph if WebGL is missing or the context is lost. |
| `GlobeScene.tsx` | The `<Canvas>`, stars, lighting, orbit controls (drag, zoom, auto-rotate), and camera easing toward the client location. Zoom buttons work through a small `GlobeApi`. |
| `Earth.tsx` | A custom shader that blends the day texture with night city lights along the sun terminator. Also ocean glint, a rim glow, a rotating cloud layer and an outer atmosphere. Falls back to a plain sphere if the textures fail to load. |
| `Network.tsx` | Location markers with pulse rings, a cache ring around the resolver, curved arcs, the travelling particle with its trail, and the DOM labels. |
| `math.ts` | Converts latitude/longitude to 3D positions and builds arcs that follow the great circle, lifted above the surface. |

Where locations come from (`src/lib/dns/geo.ts`):
- The **client** and **resolver** come from the "Client:" preset you pick (London, New York, …).
- The **root** is the nearest site from a list of anycast-style locations.
- The **TLD** uses a per-TLD location (`com` → Reston VA, `uk` → London, …).
- The **authoritative** server uses a deterministic pick from a list of data centres, based on the zone name.
- All of these are **marked "illustrative"**. Root servers are anycast (hundreds of sites share one IP), and an IP address does not reveal a server's location.

Labels are plain HTML laid over the canvas. Each frame, `LabelProjector` projects every marker's 3D position onto the screen and moves its label there, fading out labels on the far side of the globe. An earlier version used drei's `<Html>`, but that crashed when switching views.

---

## 6. Statistics and history

When the final event of a run **finishes playing**, `useDnsResolver` adds one row to the history (keeping at most 50):

`time · domain · type · mode · status · addresses · cached? · duration`

The statistics are computed from that history:
- **Total**, **Successful** (at least one address), **Failed** (NXDOMAIN, NODATA, timeout, errors)
- **Cache hits / misses**
- **Average time**: the real backend resolution time (`durationMs`), *not* the animation length

---

## 7. Error handling at a glance

| Problem | Where it's caught | What you see |
|---|---|---|
| Invalid domain | browser and TCP service (`normalizeDomain`) | red message under the input |
| Unsupported type (MX, …) | TCP service | `UNSUPPORTED_TYPE` error |
| TCP service not running | gateway | red banner "DNS service is unreachable" with a Retry button |
| Server silent | resolver (2 s per server, 15 s total) | `TIMEOUT`; the failing node turns red |
| NXDOMAIN / NODATA | resolver | red/amber result; resolver still shown as "Resolved" (it got a definitive answer) |
| Lame or invalid delegation | resolver | `SERVFAIL` |
| Connection lost mid-query | gateway | `BACKEND_UNAVAILABLE` |
| Browser leaves or starts a new search | `AbortController` → gateway sends `cancel` | old query stops and its results are ignored |
| No WebGL | `GlobeView` | notice + graph view |

---

## 8. Running and testing

```bash
npm install
npm run dev          # starts the TCP DNS service (port 7053) + Next.js (port 3000)
npm test             # integration tests over the real TCP protocol
npm run typecheck && npm run lint && npm run build
```

`server/resolver.test.ts` starts the TCP service on a random port and checks:
- the exact event order for a cache miss, then a cache hit (no root/TLD/auth events)
- AAAA, the CNAME restart, NXDOMAIN, NODATA and a glueless delegation
- the timeout scenario (reports which node failed)
- input validation and unsupported types
- one **real** iterative lookup of `example.com` (skip it offline with `SKIP_LIVE=1`)

---

## 9. File map

```
server/
  main.ts            start the TCP service
  index.ts           TCP server, NDJSON parsing, request validation, cancel/flush/ping
  resolver.ts        iterative resolver, TTL cache, event emission
  transport.ts       live UDP/TCP transport + simulated hierarchy
  wire.ts            DNS packet encoder/decoder
  resolver.test.ts   integration tests

src/shared/dns.ts            shared types, protocol, domain validation
src/server/dnsGateway.ts     persistent multiplexed TCP client (Next.js side)
src/app/api/resolve/route.ts streams events for one query
src/app/api/control/route.ts ping + flush
src/hooks/useDnsResolver.ts  streaming, playback queue, history, stats
src/lib/dns/visuals.ts       event → node state / edge / colour rules
src/lib/dns/geo.ts           illustrative globe locations
src/components/dns/
  Dashboard.tsx      page layout and controls
  DnsGraph.tsx       React Flow graph
  ui.tsx             panels: stage, result, log, history, stats, legend
  globe/             3D globe (view, scene, earth, network, math)
public/textures/     Earth textures (three.js example assets, NASA imagery)
```
