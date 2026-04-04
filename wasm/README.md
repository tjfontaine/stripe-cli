# Stripe CLI — WebAssembly Support

Run the Stripe CLI entirely in the browser via WebAssembly. No server, no native binary — just a `.wasm` file loaded by a JavaScript runtime.

This directory contains everything needed to compile stripe-cli to WASM and embed it in a web application:

```
wasm/
├── codemod/     Go AST transformer — adapts the source tree for wasip1
├── patches/     Dependency forks for wasip1 compatibility
├── wit/         WIT interface definitions (bridge contracts)
├── adapters/    Pre-built wasip1→wasip2 adapter binary
├── npm/         TypeScript runtime package (stripe-cli-wasm)
└── example/     Interactive demo — xterm.js terminal with dev server
```

## Quick start

```bash
# Prerequisites: Go 1.21+, wasm-tools (cargo install wasm-tools), Node.js 20+

# Apply source transforms and compile to WASM
make build-wasm

# Build the TypeScript runtime package
make build-wasm-npm

# Run the npm package tests
make test-wasm-npm

# Full pipeline (compile + adapt to component model + build npm)
make wasm
```

The compiled binary lands at `bin/stripe.wasm` (~47MB). The npm package at `wasm/npm/` provides the JavaScript runtime for loading it in a browser.

## Architecture

### Why WASM?

Stripe CLI in the browser enables:

- **Zero-install developer tools** — `stripe login`, `stripe customers list`, `stripe listen` work from a web terminal with no local setup
- **Privacy-first** — code execution happens client-side; API keys never leave the browser
- **Embeddable** — integrate Stripe CLI into dashboards, documentation, or developer playgrounds

### How it works

```
Go source (stripe-cli)
  ↓ make wasm-codemod (AST transforms for wasip1 compatibility)
Go source (wasip1-patched)
  ↓ GOOS=wasip1 GOARCH=wasm go build
stripe.wasm (raw wasip1 binary, ~47MB)
  ↓ wasm-tools component embed + adapt (optional, for component model)
stripe-component.wasm (wasip2 component)

Browser:
  stripe-cli-wasm (npm)  ←  loads stripe.wasm directly (bypasses component model)
    ├─ WASI Preview1 syscalls  →  FilesystemProvider (OPFS / in-memory)
    ├─ HTTP bridge             →  fetch() / XMLHttpRequest
    ├─ WebSocket bridge        →  browser WebSocket API
    └─ Browser actions         →  window.open() for OAuth
```

**Key design decision:** The raw wasip1 binary is loaded directly, bypassing the WASM Component Model adapter. Go's runtime initialization creates 568 init functions that exhaust the browser's call stack when routed through the component model's adapter trampolines. The JavaScript runtime (`wasm/npm/`) provides the WASI Preview1 ABI directly.

### Why `GOOS=wasip1` instead of `GOOS=js`

Go has two WASM targets. We use `wasip1` despite `js` having better goroutine support:

| | `GOOS=wasip1 GOARCH=wasm` | `GOOS=js GOARCH=wasm` |
|---|---|---|
| **Goroutine scheduling** | Cooperative, single-threaded. Goroutines that block on channels/timers deadlock the instance. | Event-loop integrated. `pause()` returns control to JS; `setTimeout`/`handleEvent` wake the scheduler. Goroutines work correctly. |
| **Network** | No network stack. `net.Dial` panics. Custom `wasmbridge.Transport` bridges to `fetch()`. | `net/http` wired to `fetch()` via `syscall/js`. HTTP works out of the box. |
| **Host interop** | `//go:wasmimport` only — flat functions with scalar args. No access to JS APIs. | Full `syscall/js` — direct access to DOM, fetch, WebSocket, setTimeout, etc. |
| **Filesystem** | Real WASI Preview1 filesystem (fd_open, fd_read, etc.) backed by OPFS or in-memory provider. | Fake filesystem via `syscall/js`. No standard interface. |
| **Loading** | Standard WASI module — any WASI host can load it. | Requires `wasm_exec.js` (~15KB Go runtime shim). Browser-only. |
| **Portability** | Runs in browsers, wasmtime, wazero, edge runtimes, Cloudflare Workers. | Browsers only. |
| **Ecosystem path** | wasip1 → wasip2 → wasip3 (component model, standard interfaces). | Frozen — no evolution path toward WASI standards. |

**What we give up with wasip1:** goroutine scheduling (needed the single-goroutine proxy overlay for `stripe listen`) and built-in fetch/WebSocket (needed custom bridges). **What we gain:** portability, standard WASI interfaces, and alignment with the component model ecosystem. When `GOOS=wasip3` lands ([golang/go#77141](https://github.com/golang/go/issues/77141)), we get goroutine scheduling back without losing any of these benefits.

**Dual-target possibility:** The codemod overlays are build-tagged `//go:build wasip1`. A `//go:build js` set could use `syscall/js` for bridges directly. The same source tree could produce both targets — wasip1 for portability, js for goroutine-heavy commands like `stripe listen` without the proxy overlay. This is not currently implemented but the architecture supports it.

### The codemod approach

Rather than maintaining a permanent fork with inline WASM patches scattered across the codebase, we use a **codemod** — an AST-based Go source transformer that applies targeted, reproducible modifications:

- **Build tag exclusions** (`//go:build !wasip1`) for packages that require network syscalls or subprocess execution (gRPC, terminal hardware, browser launching)
- **Function extractions** — split platform-dependent functions into `foo.go` (common) + `foo_wasip1.go` (WASM implementation) files
- **Inline replacements** — targeted edits (e.g., removing `term.IsTerminal` checks that are always false in WASM)
- **go.mod patching** — replace directives pointing to wasip1-compatible forks of dependencies

The codemod is **idempotent** — running it twice produces the same result. This makes it safe to reapply after upstream merges. The manifest (`wasm/codemod/manifest.go`) is the single source of truth for all modifications.

### What the codemod changes

| Category | Count | Examples |
|----------|-------|---------|
| Build tag exclusions | ~28 files | `pkg/rpcservice/*`, `pkg/terminal/*`, `pkg/cmd/daemon.go` |
| Function extractions | 6 functions + 1 var | `newHTTPClient`, `EditConfig`, `getFixtureFilenameWithWildcard`, `getTerminalWidth`, `connect`, `Run`, `sendMessage`, `Edit` var |
| Inline replacements | 4 | HTTP client init, terminal check, `*ws.Conn` → `wsConnIface`, `changeConnection` |
| go.mod replaces | 3 | logrus, go-git, otiai10-copy |
| Import removals | 9 | Unused imports after extractions |

Files added by overlays:
- `pkg/wasmbridge/` — HTTP and WebSocket bridges via `//go:wasmimport`
- `pkg/websocket/` — wsConnIface, wasmbridge WebSocket connection, wasip1 dial
- `pkg/proxy/` — single-goroutine proxy for `stripe listen`
- `pkg/cmd/templates_wasip1.go` — reads COLUMNS env var for help formatting
- `*_wasip1.go` platform-split files for extracted functions
- Stubs for daemon, terminal, rpcservice (wasip1 builds)

### Bridge interfaces (WIT)

The WASM binary communicates with the JavaScript host through three custom bridge interfaces, defined in [WIT (WASM Interface Types)](https://component-model.bytecodealliance.org/design/wit.html):

**`stripe:bridge/http-bridge@0.1.0`** — HTTP requests via browser `fetch()`

Go code calls `//go:wasmimport stripe:bridge/http-bridge@0.1.0 request` which the JavaScript host implements using `fetch()`. A handle-based design avoids passing complex response objects across the WASM boundary:

```
request(method, url, headers, body) → handle
response-status(handle) → status_code
response-headers(handle) → json_string
response-body-read(handle, max_bytes) → bytes
response-close(handle)
```

**`stripe:bridge/ws-bridge@0.1.0`** — WebSocket for `stripe listen`

Same handle-based pattern for real-time webhook event streaming:

```
connect(url) → handle
read(handle, max_bytes) → bytes    // 4-byte LE type prefix + payload
write(handle, data) → bytes_written
close(handle)
```

**`host:browser/actions@0.1.0`** — URL opening for `stripe login`

```
open-url(url)
```

### Why flat bridges instead of `wasi:http`?

Go's `//go:wasmimport` only supports flat functions with scalar and pointer arguments. The `wasi:http/outgoing-handler` interface uses resource handles and complex types that require the component model's canonical ABI for lifting/lowering. Since we bypass the component model (stack overflow issue), the bridge uses a deliberately simple flat ABI.

The JavaScript runtime adapts this flat ABI to whatever the embedder provides — `fetch()`, `XMLHttpRequest`, or a `wasi:http/outgoing-handler`-shaped implementation. The bridge design means Go code doesn't change when the host-side implementation changes.

### Dependency patches

Three Go dependencies need wasip1 compatibility patches:

| Dependency | Issue | Patch |
|------------|-------|-------|
| `logrus` | Signal handling and syscall detection assume Unix/Windows | Adds `terminal_check_wasip1.go`, stubs signal registration |
| `go-git` | Worktree operations use OS-specific syscalls | Adds `worktree_wasip1.go` with WASM-compatible implementations |
| `otiai10/copy` | Named pipe detection and ltime preservation | Adds `copy_namedpipes_wasip1.go`, `preserve_ltimes_wasip1.go` stubs |

These live in `wasm/patches/` and are referenced via `go.mod` replace directives. The replace paths are written by the codemod, keeping `go.mod` clean on the upstream branch.

## npm runtime package (`stripe-cli-wasm`)

The `wasm/npm/` directory contains a standalone TypeScript package that loads the WASM binary in a browser. It has **zero runtime dependencies** — just TypeScript and vitest for development.

### Usage

```typescript
import { loadStripeCli } from 'stripe-cli-wasm';
import { FetchHttpBridge } from 'stripe-cli-wasm/bridges/fetch-http-bridge';
import { WebSocketBridge } from 'stripe-cli-wasm/bridges/websocket-bridge';
import { MemoryFilesystemProvider } from 'stripe-cli-wasm/fs/memory-provider';

const stripe = await loadStripeCli({
    wasm: '/path/to/stripe.wasm',
    httpBridge: new FetchHttpBridge({
        corsProxy: '/cors-proxy',
        corsProxyRoutes: [
            { host: 'dashboard.stripe.com', pathPrefix: '/stripecli/' },
            { host: 'api.stripe.com', pathPrefix: '/v1/stripecli/' },
        ],
    }),
    wsBridge: new WebSocketBridge({ wsProxy: 'ws://localhost:3000/ws-proxy' }),
    filesystem: new MemoryFilesystemProvider(),
});

// Pass STRIPE_API_KEY via env — no `stripe login` required
const result = await stripe.run({
    args: ['stripe', 'customers', 'list', '--limit', '3'],
    env: [['STRIPE_API_KEY', 'sk_test_...']],
    stdout: (data) => terminal.write(data),
    stderr: (data) => terminal.write(data),
});
// result.exitCode === 0
```

**Note:** The CORS proxy and WebSocket proxy are server-side components needed for `stripe login` and `stripe listen`. See `wasm/example/server.mjs` for a reference implementation.

### Injection points

Every host capability is injectable — no hardcoded browser APIs:

| Interface | Required | Default implementation | Purpose |
|-----------|----------|----------------------|---------|
| `HttpBridge` | Yes | `FetchHttpBridge` (async fetch) | All Stripe API calls |
| | | `XhrHttpBridge` (sync XMLHttpRequest) | Non-JSPI environments (Safari) |
| `WsBridge` | No | `WebSocketBridge` | `stripe listen` event streaming |
| `BrowserActions` | No | `NoopBrowserActions` (console.log) | `stripe login` URL opening |
| `FilesystemProvider` | Yes | `OpfsFilesystemProvider` | Config persistence (~/.config/stripe/) |
| | | `MemoryFilesystemProvider` | Testing, quick starts, no persistence |

The `FetchHttpBridge` accepts optional CORS proxy configuration for requests that need same-origin routing (e.g., `dashboard.stripe.com/stripecli/auth`).

### JSPI (JavaScript Promise Integration)

The runtime auto-detects [JSPI](https://v8.dev/blog/jspi) support. When available (Chrome 128+), async bridge functions are wrapped with `WebAssembly.Suspending` so the WASM stack suspends while JavaScript `await`s fetch/WebSocket operations. Without JSPI, synchronous bridges (`XhrHttpBridge`) are used.

### Per-invocation instances

Each call to `stripe.run()` creates a fresh WASM instance. Go's `_start()` entry point can only execute once per instance. The compiled module is cached by the browser after first load, so subsequent invocations only pay instantiation cost (~50ms), not compilation cost.

## Updating from upstream

When upstream stripe-cli gets new commits:

```bash
# Fetch upstream changes
git fetch upstream
git rebase upstream/master

# Re-run the codemod (idempotent)
make wasm-codemod

# Verify it builds
make build-wasm

# Review and commit any changes
git diff
git add -A && git commit -m "wasm: reapply codemod after upstream merge"
```

If upstream changes conflict with codemod modifications (e.g., a function signature changes), update `wasm/codemod/manifest.go` and the corresponding overlay files.

## Future opportunities

### `wasi:http` standardization

The bridge interfaces (`stripe:bridge/http-bridge`, `stripe:bridge/ws-bridge`) are custom flat ABIs designed around Go's `//go:wasmimport` limitations. As the ecosystem matures:

- **`wasi:http/outgoing-handler`** could replace the HTTP bridge. The JavaScript runtime already supports an adapter layer.
- **`wasi:http/incoming-handler`** could enable webhook forwarding — `stripe listen --forward-to` events delivered as in-process function calls instead of HTTP POST to localhost.

### Go WASM Component Model

- **Go 1.21+**: `GOOS=wasip1` produces core WASM modules (what we use today)
- **`GOOS=wasip2`** ([golang/go#65333](https://github.com/golang/go/issues/65333)): Proposed but backlogged.
- **`GOOS=wasip3`** ([golang/go#77141](https://github.com/golang/go/issues/77141)): Active proposal. Targets async component model with proper goroutine scheduling — would eliminate the need for the single-goroutine proxy overlay and the flat bridge ABI.

### WebSocket library

The `proxy_wasip1.go` overlay works around gorilla/websocket's goroutine-heavy design. A cleaner path: replace gorilla with [coder/websocket](https://github.com/coder/websocket) which accepts `http.Client` for the upgrade handshake (routing through `wasmbridge.Transport` automatically) and uses explicit read/write calls instead of background goroutines. See the `stripe listen` section above for details.

### Binary size

The wasip1 binary is ~47MB. The browser caches the compiled module after first load. Potential optimizations: `-ldflags "-s -w"` (strips debug info), `wasm-opt` (Binaryen size optimization), lazy-loaded subcommands.

### `stripe listen` — how it works in WASM

`stripe listen` is fully functional in the browser. The implementation solves two challenges:

**1. Goroutine scheduling**

Go's wasip1 target runs all goroutines on a single thread with cooperative scheduling. The upstream stripe-cli uses gorilla/websocket with 5+ concurrent goroutines (read pump, write pump, main select loop, connection monitor, ping ticker). In wasip1, these goroutines deadlock — when one blocks on a channel waiting for another that needs to run, the entire WASM instance freezes.

The solution: a codemod overlay (`pkg/proxy/proxy_wasip1.go`) replaces the goroutine-based proxy with a **single-goroutine event loop**. WebSocket reads block via JSPI (JavaScript Promise Integration) — the WASM stack suspends until a message arrives from Stripe, then resumes to process it synchronously. No channels, no select, no time.After, no deadlocks.

```
Upstream (native):                    WASM (wasip1):
┌─ goroutine: readPump ─┐            ┌─ single goroutine ──────────┐
│  conn.ReadMessage()    │            │  for {                      │
│  → eventHandler chan   │            │    msg = ReadMessage()      │
├─ goroutine: writePump ─┤            │    // JSPI suspends here    │
│  ← send chan           │            │    ProcessEvent(msg)        │
│  conn.WriteJSON()      │            │    SendAck(msg)             │
├─ goroutine: main ──────┤            │  }                         │
│  select { ... }        │            └────────────────────────────┘
└────────────────────────┘
```

This will be unnecessary once Go supports `GOOS=wasip3` ([golang/go#77141](https://github.com/golang/go/issues/77141)), which provides per-goroutine async suspension via the WASM Component Model. The overlay can then be removed.

**2. WebSocket auth headers**

Stripe's WebSocket endpoint requires custom HTTP headers (`Websocket-Id`, `User-Agent`, `X-Stripe-Client-User-Agent`) during the upgrade handshake. The browser's `WebSocket` constructor does not support custom headers — only URL and subprotocol.

The solution: a **WebSocket proxy** on the server side. The Go code encodes auth headers as `_ws_header_*` query parameters in the WebSocket URL. The JavaScript `WebSocketBridge` routes the connection through a configurable proxy (`wsProxy` option). The proxy extracts the `_ws_header_*` params, strips them from the URL, and forwards the connection to Stripe with the headers as real HTTP headers.

```
Go WASM:
  wasmbridge.Dial("wss://stripe.com/subscribe/acct?..&_ws_header_Websocket-Id=xxx")
     ↓
WebSocketBridge (browser):
  new WebSocket("ws://localhost:3737/ws-proxy?url=wss%3A%2F%2Fstripe.com%2F...&proto=stripecli-devproxy-v1")
     ↓
Node.js ws-proxy:
  extracts _ws_header_* → sends as real HTTP headers
  new WebSocket("wss://stripe.com/subscribe/acct?websocket_feature=...", {
    headers: { "Websocket-Id": "xxx", "User-Agent": "Stripe/v1 stripe-cli/1.23.8" }
  })
     ↓
Stripe event stream ↔ relay ↔ browser ↔ WASM
```

See `wasm/example/server.mjs` for the proxy implementation.

**3. Webhook forwarding (future)**

`stripe listen --forward-to URL` forwards received events to a local HTTP endpoint. In WASM there is no local HTTP server to forward to. Future options:

- **`wasi:http/incoming-handler`** — deliver events as in-process function calls to the embedder's handler, no HTTP POST needed
- **Embedder callback** — a `WebhookForwardBridge` interface where the embedder provides a function to receive events directly

### Replacing gorilla/websocket

The goroutine workaround above is effective but adds complexity. A cleaner long-term path: replace gorilla/websocket with [coder/websocket](https://github.com/coder/websocket) (the maintained successor to nhooyr.io/websocket).

Key differences from gorilla:
- **`Dial` accepts `http.Client`** — the upgrade handshake goes through `http.Client.Do(req)`, which would route through `wasmbridge.Transport` automatically
- **No background goroutines** — read/write are explicit calls, not concurrent pumps
- **Build-tagged dial** — already has `ws_js.go` for `GOOS=js`. A `dial_wasip1.go` wrapping `wasmbridge.Conn` follows the same pattern

This would eliminate the proxy_wasip1.go overlay entirely — the library itself would be wasip1-compatible. The WebSocket proxy would still be needed for auth headers (browser limitation, not library limitation).
