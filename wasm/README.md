# Stripe CLI — WebAssembly Support

Run the Stripe CLI entirely in the browser via WebAssembly. No server, no native binary — just a `.wasm` file loaded by a JavaScript runtime.

This directory contains everything needed to compile stripe-cli to WASM and embed it in a web application:

```
wasm/
├── codemod/     Go AST transformer — adapts the source tree for wasip1
├── patches/     Dependency forks for wasip1 compatibility
├── wit/         WIT interface definitions (bridge contracts)
├── adapters/    Pre-built wasip1→wasip2 adapter binary
└── npm/         TypeScript runtime package (stripe-cli-wasm)
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
| Build tag exclusions | ~27 files | `pkg/rpcservice/*`, `pkg/terminal/*`, `pkg/cmd/daemon.go` |
| Function extractions | 3 functions + 1 var | `newHTTPClient`, `EditConfig`, `getFixtureFilenameWithWildcard`, `Edit` var |
| Inline replacements | 2 | HTTP client init, terminal check removal |
| go.mod replaces | 3 | logrus, go-git, otiai10-copy |

Files added by overlays:
- `pkg/wasmbridge/` — HTTP and WebSocket bridges via `//go:wasmimport`
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
import { OpfsFilesystemProvider } from 'stripe-cli-wasm/fs/opfs-provider';

const stripe = await loadStripeCli({
    wasm: '/path/to/stripe.wasm',
    httpBridge: new FetchHttpBridge(),
    filesystem: new OpfsFilesystemProvider('stripe'),
});

const result = await stripe.run({
    args: ['stripe', 'customers', 'list', '--limit', '3'],
    stdout: (data) => terminal.write(data),
    stderr: (data) => terminal.write(data),
});
// result.exitCode === 0
```

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

The current bridge interfaces (`stripe:bridge/http-bridge`, `stripe:bridge/ws-bridge`) are custom flat ABIs designed around Go's `//go:wasmimport` limitations. As the ecosystem matures:

- **`wasi:http/outgoing-handler`** could replace the HTTP bridge. The JavaScript runtime already supports this — an adapter layer maps the standard interface to the flat bridge. When Go gains native component model support (see below), the flat bridge can be removed entirely.
- **`wasi:http/incoming-handler`** could replace `stripe listen`'s forwarding mechanism. Currently `stripe listen --forward-to URL` makes an HTTP POST to a local endpoint — impossible in WASM. With `incoming-handler`, webhook events flow as in-process function calls. This would require a codemod addition: extract `endpoint.go`'s `Post()` method into a wasip1 overlay that calls a `webhook-forward` bridge import instead of `http.Post()`.

### WebSocket standardization

There is no WASI WebSocket specification yet. The `ws-bridge` interface is custom. When a standard emerges, the bridge can be swapped at the JavaScript runtime level without changing Go code.

### Go WASM Component Model

Go's WASM support is evolving:

- **Go 1.21+**: `GOOS=wasip1` produces core WASM modules (what we use today)
- **`GOOS=wasip2`** ([golang/go#65333](https://github.com/golang/go/issues/65333)): Proposed but backlogged. Would produce component model modules natively.
- **`GOOS=wasip3`** ([golang/go#77141](https://github.com/golang/go/issues/77141)): Active proposal (March 2026). Targets the async component model with proper goroutine scheduling — the Go team may skip wasip2 entirely.

When Go gains native component model support, the flat bridge ABI and the direct wasip1 loader can be replaced with standard `wasi:http` imports. The codemod approach means this is a surgical change to the overlays and manifest, not a rewrite.

### TinyGo alternative

[TinyGo](https://tinygo.org/) v0.33+ can produce wasip2 components natively (`tinygo build -target=wasip2`), but stripe-cli requires the full Go standard library (net/http, encoding/json, crypto, etc.) which TinyGo doesn't fully support. Standard Go remains the only viable compiler for this codebase.

### Binary size

The wasip1 binary is ~47MB. Potential optimizations:

- **`-ldflags "-s -w"`** strips debug info (already used in production builds via GoReleaser)
- **`wasm-opt`** (Binaryen) can optimize the WASM binary for size
- **Lazy-loaded subcommands** — split rarely-used commands into separate WASM modules loaded on demand
- The browser caches the compiled module after first load, so the 47MB download is a one-time cost

### `stripe listen` in-browser

Full `stripe listen` support requires:

1. ✅ WebSocket bridge for event streaming from Stripe
2. 🔲 Webhook forwarding via `wasi:http/incoming-handler` (in-process, no localhost needed)
3. 🔲 Codemod overlay for `pkg/proxy/endpoint.go` to use the bridge instead of `http.Post()`

This would enable fully in-browser webhook development — Stripe events flow directly to the developer's application code running in the same browser context.
