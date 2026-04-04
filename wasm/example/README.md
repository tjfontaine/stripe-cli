# Stripe CLI WASM — Example

A minimal browser-based Stripe CLI terminal. Type `stripe version`, `stripe help`, or any stripe command and see the output rendered in real time.

## Prerequisites

- Go 1.21+ (for building the WASM binary)
- Node.js 20+ (for the runtime package and dev server)

## Running

From the repository root:

```bash
# 1. Build the WASM binary (~47MB, takes ~30s first time)
make build-wasm

# 2. Build the runtime package and install example dependencies
cd wasm/example
npm run setup

# 3. Start the dev server
npm start
```

Open http://localhost:3000 and try:

```
stripe version
stripe help
stripe config --list
```

Commands that require authentication (e.g., `stripe customers list`) will need a `stripe login` first, which opens the Stripe OAuth flow in a new tab.

## What this demonstrates

- **WASM loading**: The 47MB binary is fetched once and compiled. The browser caches the compiled module, so subsequent page loads are instant.
- **WASI Preview1**: File system operations (config persistence) use an in-memory filesystem. Switch to `OpfsFilesystemProvider` for persistence across page reloads.
- **CORS proxy** — `stripe login` and session auth proxied to add User-Agent header
- **WebSocket proxy** — `stripe listen` WebSocket connections proxied to add auth headers (`Websocket-Id`, etc.) that browsers can't send directly
- **Per-invocation isolation** — each command creates a fresh WASM instance (Go's `_start()` runs once per instance). Filesystem state persists across commands via `MemoryFilesystemProvider`.

## `stripe listen`

Webhook event streaming works through the WebSocket proxy:

```bash
# In the terminal
stripe listen
# → Ready! Your webhook signing secret is whsec_...

# In another terminal, trigger an event
stripe trigger payment_intent.succeeded
```

The server-side WebSocket proxy (`/ws-proxy`) is required because Stripe's WebSocket endpoint requires custom HTTP headers during the upgrade handshake, which the browser `WebSocket` API doesn't support. The Go code encodes headers as `_ws_header_*` URL query params, and the proxy extracts and forwards them upstream.

## Customizing

Edit `index.html` to change the bridge configuration:

```javascript
// CORS proxy — required for stripe login and session auth
httpBridge: new FetchHttpBridge({
    corsProxy: '/cors-proxy',
    corsProxyRoutes: [
        { host: 'dashboard.stripe.com', pathPrefix: '/stripecli/' },
        { host: 'api.stripe.com', pathPrefix: '/v1/stripecli/' },
    ],
}),

// WebSocket proxy — required for stripe listen (adds auth headers)
wsBridge: new WebSocketBridge({
    wsProxy: `ws://${location.host}/ws-proxy`,
}),

// Use OPFS for persistent config (Worker context required)
filesystem: new OpfsFilesystemProvider('stripe'),
```
