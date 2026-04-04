/**
 * XMLHttpRequest-based synchronous HTTP bridge implementation.
 *
 * Uses synchronous XMLHttpRequest for environments without JSPI.
 * Same CORS proxy configuration as FetchHttpBridge.
 */

import type { HttpBridge } from './types.js';
import type { CorsProxyRoute, FetchHttpBridgeConfig } from './fetch-http-bridge.js';

interface PendingResponse {
    status: number;
    headers: string;
    body: Uint8Array;
    bodyOffset: number;
}

/**
 * HTTP bridge using synchronous XMLHttpRequest.
 *
 * `request()` returns a number synchronously (no Promise), making it
 * suitable for non-JSPI environments (Safari, Firefox Workers).
 */
export class XhrHttpBridge implements HttpBridge {
    private nextHandle = 1;
    private responses = new Map<number, PendingResponse>();
    private config: FetchHttpBridgeConfig;

    constructor(config: FetchHttpBridgeConfig = {}) {
        this.config = config;
    }

    private shouldProxy(url: string): boolean {
        if (!this.config.corsProxy || !this.config.corsProxyRoutes) return false;
        try {
            const parsed = new URL(url);
            return this.config.corsProxyRoutes.some(
                (r: CorsProxyRoute) => r.host === parsed.hostname && parsed.pathname.startsWith(r.pathPrefix),
            );
        } catch {
            return false;
        }
    }

    private getProxyUrl(targetUrl: string): string {
        const origin = typeof globalThis !== 'undefined' && 'location' in globalThis
            ? (globalThis as unknown as { location: { origin: string } }).location.origin
            : '';
        return `${origin}${this.config.corsProxy}?url=${encodeURIComponent(targetUrl)}`;
    }

    request(
        method: string,
        url: string,
        headers: string,
        body: Uint8Array,
    ): number {
        const parsedHeaders: Record<string, string> = headers ? JSON.parse(headers) : {};

        const proxied = this.shouldProxy(url);
        const fetchUrl = proxied ? this.getProxyUrl(url) : url;

        if (proxied && this.config.proxyHeaders) {
            Object.assign(parsedHeaders, this.config.proxyHeaders);
        }

        const xhr = new XMLHttpRequest();
        xhr.open(method, fetchUrl, false); // synchronous
        xhr.responseType = 'arraybuffer';

        for (const [key, value] of Object.entries(parsedHeaders)) {
            try {
                xhr.setRequestHeader(key, value);
            } catch {
                // Skip forbidden headers
            }
        }

        try {
            xhr.send(body.length > 0 ? (body as unknown as XMLHttpRequestBodyInit) : null);
        } catch (err) {
            console.error('[XhrHttpBridge] XHR error:', err);
            const handle = this.nextHandle++;
            this.responses.set(handle, {
                status: 502,
                headers: '{}',
                body: new TextEncoder().encode(`XHR error: ${err}`),
                bodyOffset: 0,
            });
            return handle;
        }

        const respHeaders: Record<string, string> = {};
        const rawHeaders = xhr.getAllResponseHeaders().trim();
        if (rawHeaders) {
            for (const line of rawHeaders.split('\r\n')) {
                const idx = line.indexOf(': ');
                if (idx > 0) {
                    respHeaders[line.substring(0, idx).toLowerCase()] = line.substring(idx + 2);
                }
            }
        }

        const handle = this.nextHandle++;
        this.responses.set(handle, {
            status: xhr.status,
            headers: JSON.stringify(respHeaders),
            body: new Uint8Array(xhr.response as ArrayBuffer),
            bodyOffset: 0,
        });
        return handle;
    }

    responseStatus(handle: number): number {
        const resp = this.responses.get(handle);
        if (!resp) return 0;
        return resp.status;
    }

    responseHeaders(handle: number): string {
        const resp = this.responses.get(handle);
        if (!resp) return '{}';
        return resp.headers;
    }

    responseBodyRead(handle: number, maxBytes: number): Uint8Array {
        const resp = this.responses.get(handle);
        if (!resp) return new Uint8Array(0);

        const remaining = resp.body.length - resp.bodyOffset;
        if (remaining <= 0) return new Uint8Array(0);

        const readLen = Math.min(remaining, maxBytes);
        const chunk = resp.body.slice(resp.bodyOffset, resp.bodyOffset + readLen);
        resp.bodyOffset += readLen;
        return chunk;
    }

    responseClose(handle: number): void {
        this.responses.delete(handle);
    }
}
