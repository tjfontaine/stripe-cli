import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WebSocketBridge } from './websocket-bridge.js';

// Mock WebSocket
class MockWebSocket {
    static instances: MockWebSocket[] = [];

    url: string;
    binaryType: string = 'blob';
    onopen: ((ev: Event) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;
    sent: (string | ArrayBuffer | Uint8Array)[] = [];
    closed = false;

    constructor(url: string) {
        this.url = url;
        MockWebSocket.instances.push(this);
    }

    send(data: string | ArrayBuffer | Uint8Array) {
        this.sent.push(data);
    }

    close() {
        this.closed = true;
    }

    // Test helpers
    simulateOpen() {
        this.onopen?.(new Event('open'));
    }

    simulateMessage(data: string | ArrayBuffer) {
        this.onmessage?.(new MessageEvent('message', { data }));
    }

    simulateClose() {
        this.onclose?.();
    }

    simulateError() {
        this.onerror?.(new Event('error'));
    }
}

describe('WebSocketBridge', () => {
    let originalWS: typeof globalThis.WebSocket;

    beforeEach(() => {
        MockWebSocket.instances = [];
        originalWS = globalThis.WebSocket;
        (globalThis as any).WebSocket = MockWebSocket;
    });

    afterEach(() => {
        globalThis.WebSocket = originalWS;
    });

    it('connect returns handle after onopen', async () => {
        const bridge = new WebSocketBridge();
        const promise = bridge.connect('wss://example.com');

        // Simulate successful open
        const ws = MockWebSocket.instances[0];
        ws.simulateOpen();

        const handle = await promise;
        expect(handle).toBeGreaterThan(0);
        expect(ws.binaryType).toBe('arraybuffer');
    });

    it('connect returns 0 on error', async () => {
        const bridge = new WebSocketBridge();
        const promise = bridge.connect('wss://bad.example.com');

        MockWebSocket.instances[0].simulateError();
        const handle = await promise;
        expect(handle).toBe(0);
    });

    it('read returns queued text messages with type prefix', async () => {
        const bridge = new WebSocketBridge();
        const connectPromise = bridge.connect('wss://example.com');
        MockWebSocket.instances[0].simulateOpen();
        const handle = await connectPromise;

        // Send a text message
        MockWebSocket.instances[0].simulateMessage('hello');

        const data = await bridge.read(handle, 65536);
        expect(data.length).toBeGreaterThan(4);

        // First 4 bytes: message type (1 = text, little-endian)
        const msgType = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
        expect(msgType).toBe(1); // TEXT_MESSAGE

        const payload = new TextDecoder().decode(data.slice(4));
        expect(payload).toBe('hello');
    });

    it('read returns queued binary messages with type prefix', async () => {
        const bridge = new WebSocketBridge();
        const connectPromise = bridge.connect('wss://example.com');
        MockWebSocket.instances[0].simulateOpen();
        const handle = await connectPromise;

        const binaryData = new Uint8Array([1, 2, 3, 4]).buffer;
        MockWebSocket.instances[0].simulateMessage(binaryData);

        const data = await bridge.read(handle, 65536);
        const msgType = new DataView(data.buffer, data.byteOffset).getUint32(0, true);
        expect(msgType).toBe(2); // BINARY_MESSAGE
        expect(Array.from(data.slice(4))).toEqual([1, 2, 3, 4]);
    });

    it('read returns empty on closed connection with no messages', async () => {
        const bridge = new WebSocketBridge();
        const connectPromise = bridge.connect('wss://example.com');
        MockWebSocket.instances[0].simulateOpen();
        const handle = await connectPromise;

        MockWebSocket.instances[0].simulateClose();

        // First read gets the close frame
        const closeFrame = await bridge.read(handle, 65536);
        const closeType = new DataView(closeFrame.buffer, closeFrame.byteOffset).getUint32(0, true);
        expect(closeType).toBe(8); // CLOSE_MESSAGE

        // Second read returns empty (EOF)
        const eof = await bridge.read(handle, 65536);
        expect(eof.length).toBe(0);
    });

    it('write sends text message to WebSocket', async () => {
        const bridge = new WebSocketBridge();
        const connectPromise = bridge.connect('wss://example.com');
        MockWebSocket.instances[0].simulateOpen();
        const handle = await connectPromise;

        const payload = new TextEncoder().encode('outgoing');
        const frame = new Uint8Array(4 + payload.length);
        new DataView(frame.buffer).setUint32(0, 1, true); // TEXT_MESSAGE
        frame.set(payload, 4);

        const written = bridge.write(handle, frame);
        expect(written).toBe(frame.length);
        expect(MockWebSocket.instances[0].sent.length).toBe(1);
        expect(MockWebSocket.instances[0].sent[0]).toBe('outgoing');
    });

    it('close closes the WebSocket', async () => {
        const bridge = new WebSocketBridge();
        const connectPromise = bridge.connect('wss://example.com');
        MockWebSocket.instances[0].simulateOpen();
        const handle = await connectPromise;

        bridge.close(handle);
        expect(MockWebSocket.instances[0].closed).toBe(true);
    });

    it('read returns empty for invalid handle', async () => {
        const bridge = new WebSocketBridge();
        const data = await bridge.read(999, 65536);
        expect(data.length).toBe(0);
    });

    it('write returns 0 for invalid handle', () => {
        const bridge = new WebSocketBridge();
        expect(bridge.write(999, new Uint8Array(8))).toBe(0);
    });
});
