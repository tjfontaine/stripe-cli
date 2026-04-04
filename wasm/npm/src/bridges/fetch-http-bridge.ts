/**
 * Fetch-based HTTP bridge implementation.
 *
 * Uses the browser's fetch() API for async HTTP requests.
 * CORS proxy configuration is injectable — no hardcoded routes.
 */

import type { HttpBridge } from './types.js';

/** Route pattern that should go through a CORS proxy. */
export interface CorsProxyRoute {
    /** Hostname to match (e.g. 'dashboard.stripe.com'). */
    host: string;
    /** Path prefix to match (e.g. '/stripecli/'). */
    pathPrefix: string;
}

/** Configuration for the fetch-based HTTP bridge. */
export interface FetchHttpBridgeConfig {
    /** CORS proxy path (e.g. '/cors-proxy'). Omit to disable proxying. */
    corsProxy?: string;
    /** Route patterns that should go through the CORS proxy. */
    corsProxyRoutes?: CorsProxyRoute[];
    /** Extra headers added to proxied requests. */
    proxyHeaders?: Record<string, string>;
}

interface PendingResponse {
    status: number;
    headers: string;
    body: Uint8Array;
    bodyOffset: number;
}

/**
 * HTTP bridge using the browser's fetch() API.
 *
 * All methods match the HttpBridge interface. `request()` returns a Promise
 * (requires JSPI or an async-capable host to use).
 */
export class FetchHttpBridge implements HttpBridge {
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
                r => r.host === parsed.hostname && parsed.pathname.startsWith(r.pathPrefix),
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

    async request(
        method: string,
        url: string,
        headers: string,
        body: Uint8Array,
    ): Promise<number> {
        const parsedHeaders: Record<string, string> = headers ? JSON.parse(headers) : {};

        const proxied = this.shouldProxy(url);
        const fetchUrl = proxied ? this.getProxyUrl(url) : url;

        if (proxied && this.config.proxyHeaders) {
            Object.assign(parsedHeaders, this.config.proxyHeaders);
        }
        if (proxied && parsedHeaders['User-Agent']) {
            parsedHeaders['X-Original-User-Agent'] = parsedHeaders['User-Agent'];
        }

        const fetchInit: RequestInit = {
            method,
            headers: parsedHeaders,
        };

        if (body.length > 0) {
            fetchInit.body = body as unknown as BodyInit;
        }

        try {
            const response = await fetch(fetchUrl, fetchInit);
            const responseBody = new Uint8Array(await response.arrayBuffer());

            const respHeaders: Record<string, string> = {};
            response.headers.forEach((value, key) => {
                respHeaders[key] = value;
            });

            const handle = this.nextHandle++;
            this.responses.set(handle, {
                status: response.status,
                headers: JSON.stringify(respHeaders),
                body: responseBody,
                bodyOffset: 0,
            });
            return handle;
        } catch (err) {
            console.error('[FetchHttpBridge] fetch error:', err);
            const handle = this.nextHandle++;
            this.responses.set(handle, {
                status: 502,
                headers: '{}',
                body: new TextEncoder().encode(`Fetch error: ${err}`),
                bodyOffset: 0,
            });
            return handle;
        }
    }

    responseStatus(handle: number): number {
        const resp = this.responses.get(handle);
        if (!resp) {
            console.error('[FetchHttpBridge] responseStatus: invalid handle', handle);
            return 0;
        }
        return resp.status;
    }

    responseHeaders(handle: number): string {
        const resp = this.responses.get(handle);
        if (!resp) {
            console.error('[FetchHttpBridge] responseHeaders: invalid handle', handle);
            return '{}';
        }
        return resp.headers;
    }

    responseBodyRead(handle: number, maxBytes: number): Uint8Array {
        const resp = this.responses.get(handle);
        if (!resp) {
            console.error('[FetchHttpBridge] responseBodyRead: invalid handle', handle);
            return new Uint8Array(0);
        }

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
