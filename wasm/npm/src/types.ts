/**
 * Core types for the Stripe CLI WASM runtime.
 */

import type { HttpBridge, WsBridge, BrowserActions } from './bridges/types.js';
import type { FilesystemProvider } from './fs/types.js';

/**
 * Configuration for loading a Stripe CLI WASM instance.
 */
export interface StripeCLIConfig {
    /**
     * The stripe.wasm binary. Can be:
     * - A URL string (fetched and compiled)
     * - A URL object (fetched and compiled)
     * - An ArrayBuffer (compiled)
     * - A pre-compiled WebAssembly.Module (used directly)
     */
    wasm: string | URL | ArrayBuffer | WebAssembly.Module;

    /** HTTP bridge for Stripe API calls. Required. */
    httpBridge: HttpBridge;

    /** WebSocket bridge for `stripe listen` event streaming. Optional. */
    wsBridge?: WsBridge;

    /** Browser actions for `stripe login` URL opening. Optional. */
    browserActions?: BrowserActions;

    /** Filesystem provider for config/data persistence. Required. */
    filesystem: FilesystemProvider;

    /**
     * Override JSPI (JavaScript Promise Integration) detection.
     * When true, async bridge functions are wrapped with WebAssembly.Suspending.
     * When false, sync-only bridges are assumed.
     * Default: auto-detect via WebAssembly.Suspending presence.
     */
    jspiAvailable?: boolean;
}

/**
 * Options for a single Stripe CLI invocation.
 */
export interface RunOptions {
    /** Command-line arguments (e.g. ['stripe', 'customers', 'list']). */
    args: string[];
    /** Environment variables as [key, value] pairs. */
    env?: [string, string][];
    /** Working directory path. Default: '/'. */
    cwd?: string;
    /** Callback for stdout data. */
    stdout: (data: Uint8Array) => void;
    /** Callback for stderr data. */
    stderr: (data: Uint8Array) => void;
    /**
     * Callback for stdin reads. Returns bytes to feed to the process.
     * Return an empty Uint8Array for EOF. If omitted, stdin returns EOF immediately.
     * May return a Promise (suspended via JSPI in async mode).
     */
    stdin?: (maxBytes: number) => Uint8Array | Promise<Uint8Array>;
}

/**
 * Result of a Stripe CLI invocation.
 */
export interface RunResult {
    /** Process exit code. 0 = success. */
    exitCode: number;
}

/**
 * A loaded Stripe CLI WASM instance.
 *
 * Each call to `run()` creates a fresh WASM instance because Go's `_start()`
 * can only execute once per instance. The browser caches the compiled module
 * after the first load.
 */
export interface StripeCLIInstance {
    /** Execute a stripe command. */
    run(options: RunOptions): Promise<RunResult>;
}
