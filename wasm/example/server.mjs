/**
 * Development server for the Stripe CLI WASM example.
 *
 * Serves:
 *   /                     → index.html
 *   /stripe-cli-wasm/*    → ../npm/dist/* (runtime package)
 *   /stripe.wasm          → ../../bin/stripe.wasm
 *   /cors-proxy?url=...   → proxied request to target URL
 */

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || '3000', 10);

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.mjs':  'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.map':  'application/json',
};

// Static file routes
const ROUTES = {
    '/stripe.wasm':     join(__dirname, '..', '..', 'bin', 'stripe.wasm'),
    '/':                join(__dirname, 'index.html'),
    '/index.html':      join(__dirname, 'index.html'),
};

// Directory prefixes → filesystem roots
const DIR_ROUTES = [
    { prefix: '/stripe-cli-wasm/', root: join(__dirname, '..', 'npm', 'dist') },
];

async function serveFile(res, filePath) {
    try {
        const data = await readFile(filePath);
        const ext = extname(filePath);
        res.writeHead(200, {
            'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'credentialless',
        });
        res.end(data);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
}

async function handleCorsProxy(req, res, targetUrl) {
    try {
        const url = new URL(targetUrl);

        // Forward the request
        const headers = { ...req.headers };
        delete headers.host;
        delete headers.origin;
        delete headers.referer;

        // Restore User-Agent from custom header if present
        if (headers['x-original-user-agent']) {
            headers['user-agent'] = headers['x-original-user-agent'];
            delete headers['x-original-user-agent'];
        }
        delete headers['x-agent-proxy'];

        const fetchInit = {
            method: req.method,
            headers,
        };

        // Forward body for POST/PUT/PATCH
        if (req.method !== 'GET' && req.method !== 'HEAD') {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            fetchInit.body = Buffer.concat(chunks);
        }

        const upstream = await fetch(url.href, fetchInit);

        // Forward response headers
        const respHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
        };
        for (const [key, value] of upstream.headers.entries()) {
            if (!['transfer-encoding', 'content-encoding', 'connection'].includes(key.toLowerCase())) {
                respHeaders[key] = value;
            }
        }

        const body = Buffer.from(await upstream.arrayBuffer());
        res.writeHead(upstream.status, respHeaders);
        res.end(body);
    } catch (err) {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`CORS proxy error: ${err.message}`);
    }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = url.pathname;

    // CORS preflight
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
            'Access-Control-Allow-Headers': '*',
            'Access-Control-Max-Age': '86400',
        });
        res.end();
        return;
    }

    // CORS proxy
    if (pathname === '/cors-proxy') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400);
            res.end('Missing url parameter');
            return;
        }
        await handleCorsProxy(req, res, targetUrl);
        return;
    }

    // Static file routes
    if (ROUTES[pathname]) {
        await serveFile(res, ROUTES[pathname]);
        return;
    }

    // Directory routes
    for (const { prefix, root } of DIR_ROUTES) {
        if (pathname.startsWith(prefix)) {
            const filePath = join(root, pathname.slice(prefix.length));
            await serveFile(res, filePath);
            return;
        }
    }

    // 404
    res.writeHead(404);
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`
  Stripe CLI WASM Example
  http://localhost:${PORT}

  Routes:
    /                    → index.html
    /stripe.wasm         → ../../bin/stripe.wasm (${formatSize(join(__dirname, '..', '..', 'bin', 'stripe.wasm'))})
    /stripe-cli-wasm/*   → ../npm/dist/*
    /cors-proxy?url=...  → CORS proxy

  Press Ctrl+C to stop.
`);
});

import { statSync } from 'node:fs';

function formatSize(filePath) {
    try {
        const s = statSync(filePath);
        return `${(s.size / 1024 / 1024).toFixed(0)}MB`;
    } catch {
        return '?';
    }
}
