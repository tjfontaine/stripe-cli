/**
 * OPFS (Origin Private File System) filesystem provider.
 *
 * Uses the File System Access API with SyncAccessHandle for fast I/O.
 * Only works in Worker/SharedWorker contexts (SyncAccessHandle requirement).
 *
 * This is a self-contained implementation — no external directory-tree.ts dependency.
 */

import type {
    FilesystemProvider, FileStat, OpenOptions, FileHandle, DirEntry,
} from './types.js';

class OpfsFileHandle implements FileHandle {
    private syncHandle: FileSystemSyncAccessHandle;
    private path: string;
    private cache: Map<string, FileSystemSyncAccessHandle>;

    constructor(
        syncHandle: FileSystemSyncAccessHandle,
        path: string,
        cache: Map<string, FileSystemSyncAccessHandle>,
    ) {
        this.syncHandle = syncHandle;
        this.path = path;
        this.cache = cache;
    }

    read(buffer: Uint8Array, offset: number): number {
        return this.syncHandle.read(buffer, { at: offset });
    }

    write(data: Uint8Array, offset: number): number {
        return this.syncHandle.write(data, { at: offset });
    }

    getSize(): number {
        return this.syncHandle.getSize();
    }

    truncate(size: number): void {
        this.syncHandle.truncate(size);
    }

    flush(): void {
        this.syncHandle.flush();
    }

    close(): void {
        try {
            this.syncHandle.close();
        } catch { /* ignore */ }
        this.cache.delete(this.path);
    }
}

/**
 * OPFS-backed filesystem provider.
 *
 * @param rootPrefix Optional path prefix within OPFS (e.g. 'stripe' creates
 *   all files under the 'stripe' subdirectory of the OPFS root).
 */
export class OpfsFilesystemProvider implements FilesystemProvider {
    private opfsRoot: FileSystemDirectoryHandle | null = null;
    private syncHandleCache = new Map<string, FileSystemSyncAccessHandle>();
    private rootPrefix: string;

    constructor(rootPrefix: string = '') {
        this.rootPrefix = rootPrefix.replace(/^\/+|\/+$/g, '');
    }

    async initialize(): Promise<void> {
        this.opfsRoot = await navigator.storage.getDirectory();
        // Ensure root prefix directory exists
        if (this.rootPrefix) {
            const parts = this.rootPrefix.split('/').filter(p => p);
            let dir = this.opfsRoot;
            for (const part of parts) {
                dir = await dir.getDirectoryHandle(part, { create: true });
            }
        }
    }

    private normalize(path: string): string {
        if (!path || path === '/') return '';
        return path.replace(/^\/+|\/+$/g, '').split('/').filter(p => p && p !== '.').join('/');
    }

    private async getRoot(): Promise<FileSystemDirectoryHandle> {
        if (!this.opfsRoot) throw new Error('OpfsFilesystemProvider not initialized');
        if (!this.rootPrefix) return this.opfsRoot;

        let dir = this.opfsRoot;
        for (const part of this.rootPrefix.split('/').filter(p => p)) {
            dir = await dir.getDirectoryHandle(part, { create: true });
        }
        return dir;
    }

    private async getDirectory(parts: string[], create: boolean): Promise<FileSystemDirectoryHandle> {
        let dir = await this.getRoot();
        for (const part of parts) {
            dir = await dir.getDirectoryHandle(part, { create });
        }
        return dir;
    }

    private async getFile(path: string, create: boolean): Promise<FileSystemFileHandle> {
        const parts = path.split('/').filter(p => p);
        if (parts.length === 0) throw new Error('Cannot open root as file');

        const fileName = parts.pop()!;
        const parentDir = parts.length > 0
            ? await this.getDirectory(parts, create)
            : await this.getRoot();

        return parentDir.getFileHandle(fileName, { create });
    }

    async stat(path: string): Promise<FileStat | null> {
        const normalized = this.normalize(path);

        // Root always exists
        if (!normalized) {
            return { type: 'directory', size: 0, mtimeMs: Date.now() };
        }

        const parts = normalized.split('/').filter(p => p);

        // Check sync handle cache first (file exists if we have a handle)
        const cachedHandle = this.syncHandleCache.get(normalized);
        if (cachedHandle) {
            try {
                return { type: 'file', size: cachedHandle.getSize(), mtimeMs: Date.now() };
            } catch { /* handle invalidated */ }
        }

        // Try as directory
        try {
            await this.getDirectory(parts, false);
            return { type: 'directory', size: 0, mtimeMs: Date.now() };
        } catch { /* not a directory */ }

        // Try as file
        try {
            const fileHandle = await this.getFile(normalized, false);
            const file = await fileHandle.getFile();
            return { type: 'file', size: file.size, mtimeMs: file.lastModified };
        } catch {
            return null;
        }
    }

    async open(path: string, options: OpenOptions = {}): Promise<FileHandle> {
        const normalized = this.normalize(path);

        if (options.directory) {
            // Directory open — no file handle needed, just verify it exists
            const parts = normalized.split('/').filter(p => p);
            await this.getDirectory(parts, !!options.create);
            // Return a dummy handle
            return {
                read: () => 0,
                write: () => 0,
                getSize: () => 0,
                truncate: () => {},
                flush: () => {},
                close: () => {},
            };
        }

        // Check cache first
        const existingHandle = this.syncHandleCache.get(normalized);
        if (existingHandle && !options.truncate) {
            return new OpfsFileHandle(existingHandle, normalized, this.syncHandleCache);
        }

        const fileHandle = await this.getFile(normalized, !!options.create);
        const syncHandle = await fileHandle.createSyncAccessHandle();
        this.syncHandleCache.set(normalized, syncHandle);

        if (options.truncate) {
            syncHandle.truncate(0);
            syncHandle.flush();
        }

        return new OpfsFileHandle(syncHandle, normalized, this.syncHandleCache);
    }

    async mkdir(path: string, recursive?: boolean): Promise<void> {
        const normalized = this.normalize(path);
        if (!normalized) return;

        const parts = normalized.split('/').filter(p => p);
        if (recursive) {
            await this.getDirectory(parts, true);
        } else {
            // Create just the final directory (parent must exist)
            const dirName = parts.pop()!;
            const parent = parts.length > 0
                ? await this.getDirectory(parts, false)
                : await this.getRoot();
            await parent.getDirectoryHandle(dirName, { create: true });
        }
    }

    async readdir(path: string): Promise<DirEntry[]> {
        const normalized = this.normalize(path);
        const parts = normalized ? normalized.split('/').filter(p => p) : [];
        const dir = parts.length > 0
            ? await this.getDirectory(parts, false)
            : await this.getRoot();

        const entries: DirEntry[] = [];
        // Use async iterator over directory entries
        for await (const [name, handle] of (dir as any).entries()) {
            entries.push({
                name,
                type: handle.kind === 'directory' ? 'directory' : 'file',
            });
        }
        return entries;
    }

    async unlink(path: string): Promise<void> {
        const normalized = this.normalize(path);
        const parts = normalized.split('/').filter(p => p);
        if (parts.length === 0) throw new Error('Cannot unlink root');

        // Close any sync handle first
        const cached = this.syncHandleCache.get(normalized);
        if (cached) {
            try { cached.close(); } catch { /* ignore */ }
            this.syncHandleCache.delete(normalized);
        }

        const fileName = parts.pop()!;
        const parentDir = parts.length > 0
            ? await this.getDirectory(parts, false)
            : await this.getRoot();
        await parentDir.removeEntry(fileName);
    }

    async rmdir(path: string): Promise<void> {
        const normalized = this.normalize(path);
        const parts = normalized.split('/').filter(p => p);
        if (parts.length === 0) throw new Error('Cannot remove root');

        // Close any sync handles under this path
        const prefix = normalized + '/';
        for (const [handlePath, handle] of this.syncHandleCache.entries()) {
            if (handlePath === normalized || handlePath.startsWith(prefix)) {
                try { handle.close(); } catch { /* ignore */ }
                this.syncHandleCache.delete(handlePath);
            }
        }

        const dirName = parts.pop()!;
        const parentDir = parts.length > 0
            ? await this.getDirectory(parts, false)
            : await this.getRoot();
        await parentDir.removeEntry(dirName, { recursive: true });
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const oldNorm = this.normalize(oldPath);
        const newNorm = this.normalize(newPath);

        // OPFS doesn't have native rename — read, write, delete
        // Close old handle first
        const oldHandle = this.syncHandleCache.get(oldNorm);
        if (oldHandle) {
            try { oldHandle.close(); } catch { /* ignore */ }
            this.syncHandleCache.delete(oldNorm);
        }

        // Read old file
        const oldFileHandle = await this.getFile(oldNorm, false);
        const file = await oldFileHandle.getFile();
        const data = new Uint8Array(await file.arrayBuffer());

        // Write to new location
        const newFileHandle = await this.getFile(newNorm, true);
        const writable = await newFileHandle.createWritable();
        await writable.write(data.buffer as ArrayBuffer);
        await writable.close();

        // Delete old file
        const oldParts = oldNorm.split('/').filter(p => p);
        const fileName = oldParts.pop()!;
        const parentDir = oldParts.length > 0
            ? await this.getDirectory(oldParts, false)
            : await this.getRoot();
        await parentDir.removeEntry(fileName);
    }
}
