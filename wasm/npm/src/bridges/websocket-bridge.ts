/**
 * Browser WebSocket bridge implementation.
 *
 * Wraps the browser's native WebSocket API to match the WsBridge interface.
 * Used primarily by `stripe listen` for real-time webhook event streaming.
 *
 * Message framing: 4-byte little-endian uint32 type prefix + payload.
 */

import type { WsBridge } from './types.js';

interface WSConnection {
    ws: WebSocket;
    messageQueue: Uint8Array[];
    closed: boolean;
    error: string | null;
    readResolve: ((value: void) => void) | null;
}

const TEXT_MESSAGE = 1;
const BINARY_MESSAGE = 2;
const CLOSE_MESSAGE = 8;

/**
 * WebSocket bridge using the browser's native WebSocket API.
 *
 * `connect()` and `read()` return Promises (require JSPI).
 * `write()` and `close()` are synchronous.
 */
export class WebSocketBridge implements WsBridge {
    private nextHandle = 1;
    private connections = new Map<number, WSConnection>();

    connect(url: string): Promise<number> {
        const handle = this.nextHandle++;
        const conn: WSConnection = {
            ws: new WebSocket(url),
            messageQueue: [],
            closed: false,
            error: null,
            readResolve: null,
        };

        this.connections.set(handle, conn);
        conn.ws.binaryType = 'arraybuffer';

        conn.ws.onmessage = (event: MessageEvent) => {
            const msgType = typeof event.data === 'string' ? TEXT_MESSAGE : BINARY_MESSAGE;
            const payload = typeof event.data === 'string'
                ? new TextEncoder().encode(event.data)
                : new Uint8Array(event.data as ArrayBuffer);

            const frame = new Uint8Array(4 + payload.length);
            new DataView(frame.buffer).setUint32(0, msgType, true);
            frame.set(payload, 4);

            conn.messageQueue.push(frame);

            if (conn.readResolve) {
                conn.readResolve();
                conn.readResolve = null;
            }
        };

        conn.ws.onclose = () => {
            conn.closed = true;
            const closeFrame = new Uint8Array(4);
            new DataView(closeFrame.buffer).setUint32(0, CLOSE_MESSAGE, true);
            conn.messageQueue.push(closeFrame);

            if (conn.readResolve) {
                conn.readResolve();
                conn.readResolve = null;
            }
        };

        conn.ws.onerror = () => {
            conn.closed = true;
            if (conn.readResolve) {
                conn.readResolve();
                conn.readResolve = null;
            }
        };

        return new Promise<number>((resolve) => {
            conn.ws.onopen = () => resolve(handle);
            const originalOnError = conn.ws.onerror;
            conn.ws.onerror = (ev) => {
                conn.closed = true;
                conn.error = 'Connection failed';
                if (originalOnError) originalOnError.call(conn.ws, ev);
                resolve(0);
            };
        });
    }

    read(handle: number, maxBytes: number): Uint8Array | Promise<Uint8Array> {
        const conn = this.connections.get(handle);
        if (!conn) return new Uint8Array(0);

        if (conn.messageQueue.length > 0) {
            return this.dequeue(conn, maxBytes);
        }

        if (conn.closed) return new Uint8Array(0);

        return new Promise<Uint8Array>((resolve) => {
            conn.readResolve = () => {
                if (conn.messageQueue.length > 0) {
                    resolve(this.dequeue(conn, maxBytes));
                } else {
                    resolve(new Uint8Array(0));
                }
            };
        });
    }

    private dequeue(conn: WSConnection, maxBytes: number): Uint8Array {
        const frame = conn.messageQueue.shift()!;
        if (frame.length <= maxBytes) return frame;
        return frame.slice(0, maxBytes);
    }

    write(handle: number, data: Uint8Array): number {
        const conn = this.connections.get(handle);
        if (!conn || conn.closed) return 0;
        if (data.length < 4) return 0;

        const msgType = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
        const payload = data.slice(4);

        try {
            if (msgType === TEXT_MESSAGE) {
                conn.ws.send(new TextDecoder().decode(payload));
            } else {
                conn.ws.send(payload);
            }
            return data.length;
        } catch (err) {
            console.error('[WebSocketBridge] write error:', err);
            return 0;
        }
    }

    close(handle: number): void {
        const conn = this.connections.get(handle);
        if (conn) {
            if (!conn.closed) {
                conn.closed = true;
                try { conn.ws.close(); } catch { /* ignore */ }
            }
            this.connections.delete(handle);
        }
    }
}
