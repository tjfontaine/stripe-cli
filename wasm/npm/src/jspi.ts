/**
 * JSPI (JavaScript Promise Integration) detection and wrapping utilities.
 *
 * JSPI allows WASM to suspend/resume on async operations (e.g., fetch, WebSocket read).
 * Without JSPI, all bridge functions must be synchronous.
 *
 * This module is self-contained — no external dependencies.
 */

// Extended WebAssembly types not yet in TypeScript's lib.dom.d.ts
const WA = WebAssembly as typeof WebAssembly & {
    Suspending?: new (fn: Function) => Function;
    promising?: (fn: Function) => Function;
};

/**
 * Detect whether the current environment supports JSPI.
 * Checks both the current API (WebAssembly.Suspending) and the future
 * API (WebAssembly.promising) for forward compatibility.
 */
export function detectJSPI(): boolean {
    return typeof WA.Suspending !== 'undefined' || typeof WA.promising !== 'undefined';
}

/**
 * Wrap an async JS function so it can be called from WASM as a suspending import.
 * When WASM calls the wrapped function, the WASM stack suspends until the
 * Promise resolves, then resumes with the result.
 *
 * @param fn An async function to wrap
 * @returns A WebAssembly.Suspending-wrapped function, or the original if JSPI unavailable
 */
export function wrapSuspending<T extends Function>(fn: T): T {
    if (WA.Suspending) {
        return new WA.Suspending(fn) as unknown as T;
    }
    return fn;
}

/**
 * Wrap a WASM export so that calling it returns a Promise that resolves
 * when the WASM function (and any suspending imports it calls) completes.
 *
 * @param fn A WASM exported function
 * @returns A promising-wrapped function, or the original if JSPI unavailable
 */
export function wrapPromising<T extends Function>(fn: T): T {
    if (WA.promising) {
        return WA.promising(fn) as unknown as T;
    }
    return fn;
}
