import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FetchHttpBridge } from './fetch-http-bridge.js';

describe('FetchHttpBridge', () => {
    let originalFetch: typeof globalThis.fetch;

    beforeEach(() => {
        originalFetch = globalThis.fetch;
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    function mockFetch(status: number, body: string, headers: Record<string, string> = {}) {
        const mockHeaders = new Headers(headers);
        globalThis.fetch = vi.fn().mockResolvedValue({
            status,
            headers: mockHeaders,
            arrayBuffer: () => Promise.resolve(new TextEncoder().encode(body).buffer),
        });
    }

    it('basic GET returns handle with status, headers, body', async () => {
        mockFetch(200, 'OK', { 'content-type': 'text/plain' });
        const bridge = new FetchHttpBridge();

        const handle = await bridge.request('GET', 'https://api.stripe.com/v1/customers', '{}', new Uint8Array(0));
        expect(handle).toBeGreaterThan(0);
        expect(bridge.responseStatus(handle)).toBe(200);

        const headers = JSON.parse(bridge.responseHeaders(handle));
        expect(headers['content-type']).toBe('text/plain');

        const body = bridge.responseBodyRead(handle, 1024);
        expect(new TextDecoder().decode(body)).toBe('OK');

        // EOF
        const eof = bridge.responseBodyRead(handle, 1024);
        expect(eof.length).toBe(0);

        bridge.responseClose(handle);
    });

    it('POST passes body to fetch', async () => {
        mockFetch(201, '{}');
        const bridge = new FetchHttpBridge();

        const body = new TextEncoder().encode('{"name":"test"}');
        await bridge.request('POST', 'https://api.stripe.com/v1/customers', '{"Content-Type":"application/json"}', body);

        expect(globalThis.fetch).toHaveBeenCalledWith(
            'https://api.stripe.com/v1/customers',
            expect.objectContaining({
                method: 'POST',
                body: expect.any(Uint8Array),
            }),
        );
    });

    it('routes through CORS proxy when configured', async () => {
        mockFetch(200, '{}');
        const bridge = new FetchHttpBridge({
            corsProxy: '/cors-proxy',
            corsProxyRoutes: [
                { host: 'dashboard.stripe.com', pathPrefix: '/stripecli/' },
            ],
            proxyHeaders: { 'X-Agent-Proxy': 'test' },
        });

        await bridge.request('POST', 'https://dashboard.stripe.com/stripecli/auth', '{}', new Uint8Array(0));

        const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toContain('/cors-proxy?url=');
        expect(calledUrl).toContain(encodeURIComponent('https://dashboard.stripe.com/stripecli/auth'));

        const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
        expect(calledHeaders['X-Agent-Proxy']).toBe('test');
    });

    it('does not proxy non-matching hosts', async () => {
        mockFetch(200, '{}');
        const bridge = new FetchHttpBridge({
            corsProxy: '/cors-proxy',
            corsProxyRoutes: [
                { host: 'dashboard.stripe.com', pathPrefix: '/stripecli/' },
            ],
        });

        await bridge.request('GET', 'https://api.stripe.com/v1/customers', '{}', new Uint8Array(0));
        const calledUrl = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
        expect(calledUrl).toBe('https://api.stripe.com/v1/customers');
    });

    it('returns 502 on fetch error', async () => {
        globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));
        const bridge = new FetchHttpBridge();

        const handle = await bridge.request('GET', 'https://bad.example.com', '{}', new Uint8Array(0));
        expect(bridge.responseStatus(handle)).toBe(502);
        const body = new TextDecoder().decode(bridge.responseBodyRead(handle, 4096));
        expect(body).toContain('Fetch error');
        bridge.responseClose(handle);
    });

    it('responseBodyRead respects maxBytes', async () => {
        mockFetch(200, 'abcdefghij');
        const bridge = new FetchHttpBridge();

        const handle = await bridge.request('GET', 'https://example.com', '{}', new Uint8Array(0));
        const chunk1 = bridge.responseBodyRead(handle, 4);
        expect(new TextDecoder().decode(chunk1)).toBe('abcd');

        const chunk2 = bridge.responseBodyRead(handle, 4);
        expect(new TextDecoder().decode(chunk2)).toBe('efgh');

        const chunk3 = bridge.responseBodyRead(handle, 4);
        expect(new TextDecoder().decode(chunk3)).toBe('ij');

        const eof = bridge.responseBodyRead(handle, 4);
        expect(eof.length).toBe(0);
        bridge.responseClose(handle);
    });

    it('handles multiple concurrent requests with independent handles', async () => {
        mockFetch(200, 'resp1');
        const bridge = new FetchHttpBridge();

        const h1 = await bridge.request('GET', 'https://a.com', '{}', new Uint8Array(0));

        mockFetch(404, 'not found');
        const h2 = await bridge.request('GET', 'https://b.com', '{}', new Uint8Array(0));

        expect(h1).not.toBe(h2);
        expect(bridge.responseStatus(h1)).toBe(200);
        expect(bridge.responseStatus(h2)).toBe(404);

        bridge.responseClose(h1);
        bridge.responseClose(h2);
    });

    it('invalid handle returns safe defaults', () => {
        const bridge = new FetchHttpBridge();
        expect(bridge.responseStatus(999)).toBe(0);
        expect(bridge.responseHeaders(999)).toBe('{}');
        expect(bridge.responseBodyRead(999, 1024).length).toBe(0);
    });
});
