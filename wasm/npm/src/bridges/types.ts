/**
 * Bridge interfaces for the Stripe CLI WASM runtime.
 *
 * These match the flat ABI that Go's `//go:wasmimport` declarations expect.
 * The runtime maps these to the raw pointer-based WASM imports at instantiation time.
 */

/**
 * HTTP bridge: executes HTTP requests on behalf of Go WASM code.
 *
 * Mirrors the `stripe:bridge/http-bridge@0.1.0` WIT interface.
 * Handle-based: `request()` returns a handle, subsequent calls use it to
 * read status/headers/body, then `responseClose()` frees it.
 */
export interface HttpBridge {
    /** Execute an HTTP request. Returns a response handle (0 = failure). */
    request(method: string, url: string, headers: string, body: Uint8Array): number | Promise<number>;
    /** Get the HTTP status code for a response handle. */
    responseStatus(handle: number): number;
    /** Get response headers as a JSON string. */
    responseHeaders(handle: number): string;
    /** Read response body data. Returns empty Uint8Array on EOF. */
    responseBodyRead(handle: number, maxBytes: number): Uint8Array;
    /** Close a response handle and free resources. */
    responseClose(handle: number): void;
}

/**
 * WebSocket bridge for `stripe listen` real-time event streaming.
 *
 * Mirrors the `stripe:bridge/ws-bridge@0.1.0` WIT interface.
 * Message framing: 4-byte little-endian uint32 message type prefix + payload.
 * Types: 1=text, 2=binary, 8=close, 9=ping, 10=pong.
 */
export interface WsBridge {
    /** Open a WebSocket connection. Returns a handle (0 = failure). */
    connect(url: string): number | Promise<number>;
    /** Read the next message. Returns empty Uint8Array on EOF/close. */
    read(handle: number, maxBytes: number): Uint8Array | Promise<Uint8Array>;
    /** Write a message. Returns bytes written (0 = failure). */
    write(handle: number, data: Uint8Array): number;
    /** Close the WebSocket connection. */
    close(handle: number): void;
}

/**
 * Browser actions. Only needed for `stripe login` OAuth flow.
 *
 * Mirrors the `host:browser/actions@0.1.0` WIT interface.
 */
export interface BrowserActions {
    /** Open a URL (e.g. Stripe login page) in the user's browser. */
    openUrl(url: string): void | Promise<void>;
}
