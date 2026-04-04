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
- **HTTP bridge**: API calls go through the browser's `fetch()` API. No CORS proxy is configured in this example, so cross-origin Stripe API calls work directly.
- **Per-invocation isolation**: Each command creates a fresh WASM instance (Go's `_start()` runs once per instance). State like environment variables and filesystem contents persist across commands via the shared `MemoryFilesystemProvider`.

## Customizing

Edit `index.html` to change the bridge configuration:

```javascript
// Add CORS proxy for stripe login (required if serving from a different origin)
httpBridge: new FetchHttpBridge({
    corsProxy: '/cors-proxy',
    corsProxyRoutes: [
        { host: 'dashboard.stripe.com', pathPrefix: '/stripecli/' },
    ],
}),

// Use OPFS for persistent config (Worker context required)
filesystem: new OpfsFilesystemProvider('stripe'),

// Add WebSocket bridge for `stripe listen`
wsBridge: new WebSocketBridge(),
```
