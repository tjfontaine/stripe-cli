import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryFilesystemProvider } from './memory-provider.js';

describe('MemoryFilesystemProvider', () => {
    let fs: MemoryFilesystemProvider;

    beforeEach(async () => {
        fs = new MemoryFilesystemProvider();
        await fs.initialize();
    });

    describe('stat', () => {
        it('returns directory for root', async () => {
            const stat = await fs.stat('/');
            expect(stat).not.toBeNull();
            expect(stat!.type).toBe('directory');
        });

        it('returns null for non-existent path', async () => {
            expect(await fs.stat('/nope')).toBeNull();
        });
    });

    describe('mkdir + stat', () => {
        it('creates a directory', async () => {
            await fs.mkdir('/config', true);
            const stat = await fs.stat('/config');
            expect(stat).not.toBeNull();
            expect(stat!.type).toBe('directory');
        });

        it('creates nested directories recursively', async () => {
            await fs.mkdir('/a/b/c', true);
            expect((await fs.stat('/a'))!.type).toBe('directory');
            expect((await fs.stat('/a/b'))!.type).toBe('directory');
            expect((await fs.stat('/a/b/c'))!.type).toBe('directory');
        });
    });

    describe('file read/write roundtrip', () => {
        it('creates, writes, reads back data', async () => {
            const handle = await fs.open('/test.txt', { create: true });
            const data = new TextEncoder().encode('hello world');
            handle.write(data, 0);
            handle.flush();

            expect(handle.getSize()).toBe(11);

            const buf = new Uint8Array(11);
            const bytesRead = handle.read(buf, 0);
            expect(bytesRead).toBe(11);
            expect(new TextDecoder().decode(buf)).toBe('hello world');
            handle.close();
        });

        it('reads partial data with offset', async () => {
            const handle = await fs.open('/test.txt', { create: true });
            handle.write(new TextEncoder().encode('abcdef'), 0);

            const buf = new Uint8Array(3);
            const bytesRead = handle.read(buf, 2);
            expect(bytesRead).toBe(3);
            expect(new TextDecoder().decode(buf)).toBe('cde');
            handle.close();
        });

        it('writes at offset extends file', async () => {
            const handle = await fs.open('/test.txt', { create: true });
            handle.write(new TextEncoder().encode('aa'), 0);
            handle.write(new TextEncoder().encode('bb'), 5);
            expect(handle.getSize()).toBe(7);
            handle.close();
        });
    });

    describe('readdir', () => {
        it('lists direct children only', async () => {
            await fs.mkdir('/dir', true);
            await (await fs.open('/dir/a.txt', { create: true })).close();
            await (await fs.open('/dir/b.txt', { create: true })).close();
            await fs.mkdir('/dir/sub', true);
            await (await fs.open('/dir/sub/deep.txt', { create: true })).close();

            const entries = await fs.readdir('/dir');
            const names = entries.map(e => e.name).sort();
            expect(names).toEqual(['a.txt', 'b.txt', 'sub']);

            const sub = entries.find(e => e.name === 'sub');
            expect(sub!.type).toBe('directory');
        });
    });

    describe('unlink', () => {
        it('removes a file', async () => {
            await (await fs.open('/del.txt', { create: true })).close();
            expect(await fs.stat('/del.txt')).not.toBeNull();
            await fs.unlink('/del.txt');
            expect(await fs.stat('/del.txt')).toBeNull();
        });
    });

    describe('rmdir', () => {
        it('removes directory and contents', async () => {
            await fs.mkdir('/rmme/sub', true);
            await (await fs.open('/rmme/sub/file.txt', { create: true })).close();
            await fs.rmdir('/rmme');
            expect(await fs.stat('/rmme')).toBeNull();
            expect(await fs.stat('/rmme/sub')).toBeNull();
            expect(await fs.stat('/rmme/sub/file.txt')).toBeNull();
        });
    });

    describe('rename', () => {
        it('moves a file', async () => {
            const h = await fs.open('/old.txt', { create: true });
            h.write(new TextEncoder().encode('content'), 0);
            h.close();

            await fs.rename('/old.txt', '/new.txt');
            expect(await fs.stat('/old.txt')).toBeNull();

            const h2 = await fs.open('/new.txt', {});
            const buf = new Uint8Array(7);
            h2.read(buf, 0);
            expect(new TextDecoder().decode(buf)).toBe('content');
            h2.close();
        });
    });

    describe('open options', () => {
        it('truncate zeros existing file', async () => {
            const h1 = await fs.open('/trunc.txt', { create: true });
            h1.write(new TextEncoder().encode('data'), 0);
            h1.close();

            const h2 = await fs.open('/trunc.txt', { truncate: true });
            expect(h2.getSize()).toBe(0);
            h2.close();
        });

        it('stat returns correct file size', async () => {
            const h = await fs.open('/sized.txt', { create: true });
            h.write(new TextEncoder().encode('12345'), 0);
            h.close();

            const stat = await fs.stat('/sized.txt');
            expect(stat!.size).toBe(5);
        });
    });

    describe('path normalization', () => {
        it('handles double slashes', async () => {
            await (await fs.open('//test//file.txt', { create: true })).close();
            expect(await fs.stat('/test/file.txt')).not.toBeNull();
        });

        it('handles trailing slashes', async () => {
            await fs.mkdir('/trailing/', true);
            expect(await fs.stat('/trailing')).not.toBeNull();
        });
    });
});
