import { describe, it, expect, vi } from 'vitest';
import {
    createMemoryAccess,
    createHttpBridgeImports,
    createWsBridgeImports,
    createBrowserImports,
} from './bridge-wiring.js';
import type { HttpBridge, WsBridge, BrowserActions } from './bridges/types.js';

describe('bridge-wiring', () => {
    // Set up a small WASM-like memory and a mock realloc
    function createMockMemory() {
        const buffer = new ArrayBuffer(4096);
        let allocOffset = 256; // Start allocating at offset 256

        const getMem = () => buffer;
        const getRealloc = () => (_oldPtr: number, _oldSize: number, _align: number, newSize: number) => {
            const ptr = allocOffset;
            allocOffset += newSize;
            return ptr;
        };

        return { buffer, getMem, getRealloc };
    }

    describe('createMemoryAccess', () => {
        it('readString decodes UTF-8', () => {
            const { buffer, getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            const text = 'hello';
            const encoded = new TextEncoder().encode(text);
            new Uint8Array(buffer, 0, encoded.length).set(encoded);

            expect(mem.readString(0, encoded.length)).toBe('hello');
        });

        it('readBytes returns detached copy', () => {
            const { buffer, getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            new Uint8Array(buffer, 10, 3).set([1, 2, 3]);
            const bytes = mem.readBytes(10, 3);
            expect(Array.from(bytes)).toEqual([1, 2, 3]);

            // Modify source — copy should be unaffected
            new Uint8Array(buffer, 10, 1).set([99]);
            expect(bytes[0]).toBe(1);
        });

        it('allocAndWrite allocates and writes data', () => {
            const { buffer, getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            const data = new Uint8Array([10, 20, 30]);
            const ptr = mem.allocAndWrite(data);
            expect(ptr).toBeGreaterThanOrEqual(256);

            const written = new Uint8Array(buffer, ptr, 3);
            expect(Array.from(written)).toEqual([10, 20, 30]);
        });

        it('allocAndWrite returns 0 for empty data', () => {
            const { getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);
            expect(mem.allocAndWrite(new Uint8Array(0))).toBe(0);
        });
    });

    describe('createHttpBridgeImports', () => {
        it('produces import object with all 5 bridge functions', () => {
            const { getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            const mockBridge: HttpBridge = {
                request: vi.fn().mockReturnValue(1),
                responseStatus: vi.fn().mockReturnValue(200),
                responseHeaders: vi.fn().mockReturnValue('{}'),
                responseBodyRead: vi.fn().mockReturnValue(new Uint8Array(0)),
                responseClose: vi.fn(),
            };

            const imports = createHttpBridgeImports(mem, mockBridge, false);
            expect(imports).toHaveProperty('request');
            expect(imports).toHaveProperty('response-status');
            expect(imports).toHaveProperty('response-headers');
            expect(imports).toHaveProperty('response-body-read');
            expect(imports).toHaveProperty('response-close');
        });
    });

    describe('createWsBridgeImports', () => {
        it('produces import object with all 4 bridge functions', () => {
            const { getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            const mockBridge: WsBridge = {
                connect: vi.fn().mockReturnValue(1),
                read: vi.fn().mockReturnValue(new Uint8Array(0)),
                write: vi.fn().mockReturnValue(0),
                close: vi.fn(),
            };

            const imports = createWsBridgeImports(mem, mockBridge, false);
            expect(imports).toHaveProperty('connect');
            expect(imports).toHaveProperty('read');
            expect(imports).toHaveProperty('write');
            expect(imports).toHaveProperty('close');
        });
    });

    describe('createBrowserImports', () => {
        it('produces import object with open-url function', () => {
            const { getMem, getRealloc } = createMockMemory();
            const mem = createMemoryAccess(getMem, getRealloc);

            const mockActions: BrowserActions = {
                openUrl: vi.fn(),
            };

            const imports = createBrowserImports(mem, mockActions, false);
            expect(imports).toHaveProperty('open-url');
        });
    });
});
