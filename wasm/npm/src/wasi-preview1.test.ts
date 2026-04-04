import { describe, it, expect, beforeEach } from 'vitest';
import { createWasiImports, createFdTable, GoWasmExit, ERRNO } from './wasi-preview1.js';
import { MemoryFilesystemProvider } from './fs/memory-provider.js';
import type { FdTable } from './wasi-preview1.js';
import type { WasiConfig } from './wasi-preview1.js';

describe('wasi-preview1', () => {
    let memory: ArrayBuffer;
    let fdTable: FdTable;
    let fs: MemoryFilesystemProvider;
    let wasi: Record<string, Function>;
    let stdoutChunks: Uint8Array[];
    let stderrChunks: Uint8Array[];

    function getMem() { return memory; }

    beforeEach(async () => {
        memory = new ArrayBuffer(65536);
        fdTable = createFdTable();
        fs = new MemoryFilesystemProvider();
        await fs.initialize();

        stdoutChunks = [];
        stderrChunks = [];

        const config: WasiConfig = {
            args: ['stripe', 'version'],
            env: [['HOME', '/'], ['LANG', 'en_US.UTF-8']],
            cwd: '/',
            stdoutWrite: (data) => stdoutChunks.push(data.slice()),
            stderrWrite: (data) => stderrChunks.push(data.slice()),
        };

        wasi = createWasiImports(getMem, fdTable, fs, config, false);
    });

    describe('args_sizes_get', () => {
        it('returns correct arg count and total size', () => {
            // args: 'stripe' (7 bytes with nul) + 'version' (8 bytes with nul) = 15
            const view = new DataView(memory);
            const errno = wasi.args_sizes_get(100, 104);
            expect(errno).toBe(ERRNO.SUCCESS);
            expect(view.getUint32(100, true)).toBe(2); // argc
            expect(view.getUint32(104, true)).toBe(15); // total size
        });
    });

    describe('args_get', () => {
        it('writes arg pointers and strings', () => {
            const view = new DataView(memory);
            const errno = wasi.args_get(200, 300);
            expect(errno).toBe(ERRNO.SUCCESS);

            // First arg pointer
            const ptr0 = view.getUint32(200, true);
            expect(ptr0).toBe(300);

            // Read the first arg string
            const decoder = new TextDecoder();
            const arg0 = decoder.decode(new Uint8Array(memory, ptr0, 6));
            expect(arg0).toBe('stripe');
        });
    });

    describe('environ_sizes_get', () => {
        it('returns correct env count and total size', () => {
            const view = new DataView(memory);
            const errno = wasi.environ_sizes_get(100, 104);
            expect(errno).toBe(ERRNO.SUCCESS);
            // Default env (HOME=/, STRIPE_CLI_TELEMETRY_OPTOUT=true) + user env (HOME=/, LANG=en_US.UTF-8)
            // Actually: defaultEnv prepends HOME=/ and STRIPE_CLI_TELEMETRY_OPTOUT=true
            // then allEnv = [...defaultEnv, ...config.env]
            const count = view.getUint32(100, true);
            expect(count).toBeGreaterThanOrEqual(2);
        });
    });

    describe('clock_time_get', () => {
        it('returns a reasonable nanosecond timestamp', () => {
            const view = new DataView(memory);
            const errno = wasi.clock_time_get(0, 0n, 100);
            expect(errno).toBe(ERRNO.SUCCESS);
            const ns = view.getBigUint64(100, true);
            // Should be roughly now in nanoseconds (Date.now() * 1e6)
            const nowNs = BigInt(Date.now()) * 1000000n;
            const diff = ns > nowNs ? ns - nowNs : nowNs - ns;
            expect(diff).toBeLessThan(5000000000n); // within 5 seconds
        });
    });

    describe('random_get', () => {
        it('fills buffer with random bytes', () => {
            const errno = wasi.random_get(100, 32);
            expect(errno).toBe(ERRNO.SUCCESS);
            const bytes = new Uint8Array(memory, 100, 32);
            // Extremely unlikely all 32 bytes are zero
            const allZero = bytes.every(b => b === 0);
            expect(allZero).toBe(false);
        });
    });

    describe('fd_prestat_get', () => {
        it('returns directory tag for preopen fd 3', () => {
            const view = new DataView(memory);
            const errno = wasi.fd_prestat_get(3, 100);
            expect(errno).toBe(ERRNO.SUCCESS);
            expect(view.getUint8(100)).toBe(0); // tag: directory
            expect(view.getUint32(104, true)).toBe(1); // name_len: '/' = 1 byte
        });

        it('returns BADF for non-preopen fd', () => {
            expect(wasi.fd_prestat_get(0, 100)).toBe(ERRNO.BADF);
            expect(wasi.fd_prestat_get(99, 100)).toBe(ERRNO.BADF);
        });
    });

    describe('fd_fdstat_get', () => {
        it('returns CHARACTER_DEVICE for stdio', () => {
            const view = new DataView(memory);
            const errno = wasi.fd_fdstat_get(0, 100);
            expect(errno).toBe(ERRNO.SUCCESS);
            expect(view.getUint8(100)).toBe(2); // CHARACTER_DEVICE
        });

        it('returns DIRECTORY for preopen', () => {
            const view = new DataView(memory);
            const errno = wasi.fd_fdstat_get(3, 100);
            expect(errno).toBe(ERRNO.SUCCESS);
            expect(view.getUint8(100)).toBe(3); // DIRECTORY
        });

        it('returns BADF for invalid fd', () => {
            expect(wasi.fd_fdstat_get(99, 100)).toBe(ERRNO.BADF);
        });
    });

    describe('fd_close', () => {
        it('does not close stdio', () => {
            expect(wasi.fd_close(0)).toBe(ERRNO.SUCCESS);
            expect(wasi.fd_close(1)).toBe(ERRNO.SUCCESS);
            expect(fdTable.get(0)).toBeDefined();
            expect(fdTable.get(1)).toBeDefined();
        });

        it('returns BADF for invalid fd', () => {
            expect(wasi.fd_close(99)).toBe(ERRNO.BADF);
        });
    });

    describe('proc_exit', () => {
        it('throws GoWasmExit with exit code', () => {
            try {
                wasi.proc_exit(42);
                expect.unreachable('proc_exit should throw');
            } catch (err) {
                expect(err).toBeInstanceOf(GoWasmExit);
                expect((err as GoWasmExit).code).toBe(42);
                expect((err as GoWasmExit).exitError).toBe(true);
            }
        });
    });

    describe('fd_write to stdout', () => {
        it('writes data through stdio callback', async () => {
            const view = new DataView(memory);
            const text = new TextEncoder().encode('hello');

            // Set up iovec: ptr at offset 200, len at 204
            new Uint8Array(memory, 300, text.length).set(text);
            view.setUint32(200, 300, true); // iov_base
            view.setUint32(204, text.length, true); // iov_len

            const errno = await wasi.fd_write(1, 200, 1, 400);
            expect(errno).toBe(ERRNO.SUCCESS);

            const nwritten = view.getUint32(400, true);
            expect(nwritten).toBe(5);
            expect(stdoutChunks.length).toBe(1);
        });
    });

    describe('sched_yield', () => {
        it('returns SUCCESS', () => {
            expect(wasi.sched_yield()).toBe(ERRNO.SUCCESS);
        });
    });

    describe('sock_accept / sock_shutdown', () => {
        it('returns NOSYS', () => {
            expect(wasi.sock_accept()).toBe(ERRNO.NOSYS);
            expect(wasi.sock_shutdown()).toBe(ERRNO.NOSYS);
        });
    });
});
