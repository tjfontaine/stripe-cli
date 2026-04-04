/**
 * Go WASI Preview1 loader — orchestrates WASM module instantiation.
 *
 * This loader bypasses the WASM Component Model (JCO transpilation) to avoid
 * stack overflow caused by the wasip1-to-wasip2 adapter's deep call chains.
 * Go's runtime initialization with 568 init functions exhausts the browser's
 * WASM call stack when routed through component model trampolines.
 *
 * Instead, the raw wasip1 Go binary is instantiated directly with hand-wired
 * WASI Preview1 imports and bridge functions.
 */

import type { StripeCLIConfig, StripeCLIInstance, RunOptions, RunResult } from './types.js';
import { detectJSPI, wrapPromising } from './jspi.js';
import { createWasiImports, createFdTable, GoWasmExit } from './wasi-preview1.js';
import {
    createMemoryAccess,
    createHttpBridgeImports,
    createWsBridgeImports,
    createBrowserImports,
} from './bridge-wiring.js';

/**
 * Load the Stripe CLI WASM binary and return an instance that can run commands.
 *
 * The WASM module is compiled once and reused. Each `run()` call creates a
 * fresh WebAssembly instance because Go's `_start()` can only execute once.
 */
export async function loadStripeCli(config: StripeCLIConfig): Promise<StripeCLIInstance> {
    // Initialize the filesystem provider
    await config.filesystem.initialize();

    // Compile the WASM module (cached by the browser after first load)
    const module = await compileModule(config.wasm);

    const jspi = config.jspiAvailable ?? detectJSPI();

    return {
        async run(options: RunOptions): Promise<RunResult> {
            return runInstance(module, config, options, jspi);
        },
    };
}

// ============================================================================
// Internal: compile WASM module from various source types
// ============================================================================

async function compileModule(
    source: string | URL | ArrayBuffer | WebAssembly.Module,
): Promise<WebAssembly.Module> {
    if (source instanceof WebAssembly.Module) {
        return source;
    }

    if (source instanceof ArrayBuffer) {
        return WebAssembly.compile(source);
    }

    // URL or string — fetch and compile
    const url = source instanceof URL ? source.href : source;
    const response = await fetch(url);
    return WebAssembly.compileStreaming(response);
}

// ============================================================================
// Internal: create a fresh instance and run _start()
// ============================================================================

async function runInstance(
    module: WebAssembly.Module,
    config: StripeCLIConfig,
    options: RunOptions,
    jspi: boolean,
): Promise<RunResult> {
    // Memory reference — updated after instantiation
    let wasmMemory: WebAssembly.Memory;
    const getMem = (): ArrayBuffer => wasmMemory.buffer;

    // cabi_realloc — set after instantiation
    let cabiRealloc: (oldPtr: number, oldSize: number, align: number, newSize: number) => number;

    // Create memory access helpers
    const mem = createMemoryAccess(getMem, () => cabiRealloc);

    // Create file descriptor table
    const fdTable = createFdTable();

    // Create WASI Preview1 imports
    const wasiConfig = {
        args: options.args,
        env: options.env || [],
        cwd: options.cwd || '/',
        stdoutWrite: options.stdout,
        stderrWrite: options.stderr,
    };
    const wasiImports = createWasiImports(getMem, fdTable, config.filesystem, wasiConfig, jspi);

    // Create bridge imports
    const httpBridgeImports = createHttpBridgeImports(mem, config.httpBridge, jspi);

    // Assemble the full import object
    const imports: Record<string, WebAssembly.ModuleImports> = {
        wasi_snapshot_preview1: wasiImports as WebAssembly.ModuleImports,
        'stripe:bridge/http-bridge@0.1.0': httpBridgeImports as WebAssembly.ModuleImports,
        // Also provide as git:bridge for git-module compatibility
        'git:bridge/http-bridge@0.1.0': httpBridgeImports as WebAssembly.ModuleImports,
    };

    if (config.wsBridge) {
        const wsBridgeImports = createWsBridgeImports(mem, config.wsBridge, jspi);
        imports['stripe:bridge/ws-bridge@0.1.0'] = wsBridgeImports as WebAssembly.ModuleImports;
    }

    if (config.browserActions) {
        const browserImports = createBrowserImports(mem, config.browserActions, jspi);
        imports['host:browser/actions@0.1.0'] = browserImports as WebAssembly.ModuleImports;
    }

    // Instantiate
    const instance = await WebAssembly.instantiate(module, imports);

    wasmMemory = instance.exports.memory as WebAssembly.Memory;
    cabiRealloc = instance.exports.cabi_realloc as typeof cabiRealloc;

    // Wrap _start with WebAssembly.promising if JSPI is available
    const rawStart = instance.exports._start as () => void;
    const start = (jspi ? wrapPromising(rawStart) : rawStart) as () => void | Promise<void>;

    // Run
    try {
        await start();
        return { exitCode: 0 };
    } catch (err: unknown) {
        // GoWasmExit is thrown by proc_exit — extract the exit code
        if (err && typeof err === 'object' && 'exitError' in err) {
            return { exitCode: (err as GoWasmExit).code };
        }
        throw err;
    }
}

export { GoWasmExit };
