/**
 * Bridge wiring: maps high-level HttpBridge/WsBridge/BrowserActions interfaces
 * to the raw pointer-based WASM import functions that Go expects.
 *
 * Go's `//go:wasmimport` declarations use flat ABI: strings become (ptr, len) pairs,
 * list<u8> becomes (ptr, len), and return values for complex types use a retptr.
 * This module handles the lifting/lowering between JavaScript types and WASM memory.
 */

import type { HttpBridge, WsBridge, BrowserActions } from './bridges/types.js';
import { wrapSuspending } from './jspi.js';

/**
 * Memory access helpers.
 * These are created once per module instantiation and shared across all bridges.
 */
export interface MemoryAccess {
    /** Get the current WASM memory ArrayBuffer (may change on memory.grow). */
    getMem(): ArrayBuffer;
    /** Allocate WASM memory via cabi_realloc and write bytes, returning the pointer. */
    allocAndWrite(data: Uint8Array): number;
    /** Read a string from WASM memory. */
    readString(ptr: number, len: number): string;
    /** Read bytes from WASM memory (returns a copy detached from the buffer). */
    readBytes(ptr: number, len: number): Uint8Array;
}

export function createMemoryAccess(
    getMem: () => ArrayBuffer,
    getRealloc: () => (oldPtr: number, oldSize: number, align: number, newSize: number) => number,
): MemoryAccess {
    const textDecoder = new TextDecoder();

    return {
        getMem,

        allocAndWrite(data: Uint8Array): number {
            if (data.length === 0) return 0;
            const ptr = getRealloc()(0, 0, 1, data.length);
            new Uint8Array(getMem(), ptr, data.length).set(data);
            return ptr;
        },

        readString(ptr: number, len: number): string {
            return textDecoder.decode(new Uint8Array(getMem(), ptr, len));
        },

        readBytes(ptr: number, len: number): Uint8Array {
            return new Uint8Array(getMem(), ptr, len).slice();
        },
    };
}

// ============================================================================
// HTTP Bridge imports (stripe:bridge/http-bridge@0.1.0)
// ============================================================================

export function createHttpBridgeImports(
    mem: MemoryAccess,
    bridge: HttpBridge,
    jspi: boolean,
): Record<string, Function> {
    const textEncoder = new TextEncoder();

    // request: func(method: string, url: string, headers: string, body: list<u8>) -> u32
    // canonical ABI: (method_ptr, method_len, url_ptr, url_len, headers_ptr, headers_len, body_ptr, body_len) -> handle
    const requestFn = function (
        methodPtr: number, methodLen: number,
        urlPtr: number, urlLen: number,
        headersPtr: number, headersLen: number,
        bodyPtr: number, bodyLen: number,
    ): number | Promise<number> {
        const method = mem.readString(methodPtr, methodLen);
        const url = mem.readString(urlPtr, urlLen);
        const headers = mem.readString(headersPtr, headersLen);
        const body = mem.readBytes(bodyPtr, bodyLen);
        return bridge.request(method, url, headers, body);
    };

    return {
        'request': jspi ? wrapSuspending(requestFn) : requestFn,

        'response-status'(handle: number): number {
            return bridge.responseStatus(handle);
        },

        // response-headers returns a string via retptr: host writes (ptr: u32, len: u32)
        'response-headers'(handle: number, retptr: number): void {
            const headers = bridge.responseHeaders(handle);
            const encoded = textEncoder.encode(headers);
            const ptr = mem.allocAndWrite(encoded);
            const view = new DataView(mem.getMem());
            view.setUint32(retptr, ptr, true);
            view.setUint32(retptr + 4, encoded.length, true);
        },

        // response-body-read returns list<u8> via retptr: host writes (ptr: u32, len: u32)
        'response-body-read'(handle: number, maxBytes: number, retptr: number): void {
            const data = bridge.responseBodyRead(handle, maxBytes);
            const ptr = mem.allocAndWrite(data);
            const view = new DataView(mem.getMem());
            view.setUint32(retptr, ptr, true);
            view.setUint32(retptr + 4, data.length, true);
        },

        'response-close'(handle: number): void {
            bridge.responseClose(handle);
        },
    };
}

// ============================================================================
// WebSocket Bridge imports (stripe:bridge/ws-bridge@0.1.0)
// ============================================================================

export function createWsBridgeImports(
    mem: MemoryAccess,
    bridge: WsBridge,
    jspi: boolean,
): Record<string, Function> {
    // connect: func(url: string) -> u32
    // canonical ABI: (url_ptr, url_len) -> handle
    const connectFn = function (urlPtr: number, urlLen: number): number | Promise<number> {
        const url = mem.readString(urlPtr, urlLen);
        return bridge.connect(url);
    };

    // read: func(handle: u32, max-bytes: u32) -> list<u8>
    // canonical ABI: (handle, max_bytes, retptr) -> void
    const readFn = async function (handle: number, maxBytes: number, retptr: number): Promise<void> {
        const data = await bridge.read(handle, maxBytes);
        const ptr = mem.allocAndWrite(data);
        const view = new DataView(mem.getMem());
        view.setUint32(retptr, ptr, true);
        view.setUint32(retptr + 4, data.length, true);
    };

    const syncReadFn = function (handle: number, maxBytes: number, retptr: number): void {
        // Sync fallback: non-blocking read returns whatever is queued
        const data = bridge.read(handle, maxBytes) as Uint8Array;
        const ptr = mem.allocAndWrite(data);
        const view = new DataView(mem.getMem());
        view.setUint32(retptr, ptr, true);
        view.setUint32(retptr + 4, data.length, true);
    };

    // write: func(handle: u32, data: list<u8>) -> u32
    // canonical ABI: (handle, data_ptr, data_len) -> written
    const writeFn = function (handle: number, dataPtr: number, dataLen: number): number {
        const data = mem.readBytes(dataPtr, dataLen);
        return bridge.write(handle, data);
    };

    return {
        'connect': jspi ? wrapSuspending(connectFn) : connectFn,
        'read': jspi ? wrapSuspending(readFn) : syncReadFn,
        'write': writeFn,
        'close'(handle: number): void {
            bridge.close(handle);
        },
    };
}

// ============================================================================
// Browser Actions imports (host:browser/actions@0.1.0)
// ============================================================================

export function createBrowserImports(
    mem: MemoryAccess,
    actions: BrowserActions,
    jspi: boolean,
): Record<string, Function> {
    const openUrlFn = function (urlPtr: number, urlLen: number): void | Promise<void> {
        const url = mem.readString(urlPtr, urlLen);
        return actions.openUrl(url);
    };

    return {
        'open-url': jspi ? wrapSuspending(openUrlFn) : openUrlFn,
    };
}
