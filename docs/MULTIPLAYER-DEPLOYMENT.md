# Multiplayer server: VM / VPS deployment (single region)

This complements the in-code comments in `server.js`. It does **not** cover geo-distributed or multi-region hosting — only how to run one or more realms on dedicated hardware.

## Dedicated VM or VPS

- **Single process** = one realm (`REALM_ID`). The game server is Node.js + WebSockets; each connected client receives interest-filtered `state` and global `npc_sync` at the simulation rate.
- **Vertical scaling first:** more CPU reduces per-tick work headroom; more RAM helps WebSocket buffers, player records, and persistence. A practical starting point for tens of concurrent captains is **2 vCPU / 2 GB RAM** on the same network as your static file host, then load-test.
- **Horizontal scaling (not regional):** run **multiple Node processes** with different `REALM_ID` / `PORT` (or behind a TCP load balancer that pins by port). Each realm is a separate ocean and player cap. Clients point to a realm URL you choose; this is “more servers” in the sense of more game instances, not automatic geographic routing.

## Process manager

Use **systemd**, **PM2**, **Docker**, or your host’s equivalent so the process restarts on crash and picks up `NODE_ENV=production`.

- Set environment variables from `multiplayer-server.example.env` (copy to your actual env or secret store).
- **Bind** listening to `0.0.0.0` (already the default in code) so reverse proxies can forward to the app port.
- Put **TLS termination** on nginx/Caddy/HAProxy in front if you expose WSS to browsers; the app itself speaks plain WebSocket behind the proxy.

## Tunables (same region)

| Variable | Purpose |
|----------|---------|
| `MAX_CONCURRENT_CAPTAINS` | Hard cap on simultaneous logins |
| `STATE_AOI_RADIUS` | World units — larger means more peers per `state` snapshot and more JSON per tick for nearby fights |
| `WS_PING_INTERVAL_MS` | Detect dead tabs; lower = more control traffic |
| `PORT` | Listen port |

After changing **simulation tick rate** (`TICK_RATE` in `server.js`, default **90**), align the client (`NET_SYNC_HZ` in `index.html`) — higher Hz yields smoother remote NPC interpolation at the cost of more bandwidth/CPU.

## Static files

Ship `index.html` and assets from any static host or the same machine; the game client only needs a reachable **WebSocket URL** to this server. Separate static and game hosts is fine (CORS is already set for API-like responses in `server.js` where applicable).
