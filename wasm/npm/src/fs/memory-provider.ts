/**
 * In-memory filesystem provider.
 *
 * Uses a simple Map<string, Uint8Array> for file storage.
 * No persistence across page reloads — suitable for testing and quick starts.
 */

import type {
    FilesystemProvider, FileStat, OpenOptions, FileHandle, DirEntry,
} from './types.js';

interface FileNode {
    type: 'file';
    data: Uint8Array;
    mtimeMs: number;
}

interface DirNode {
    type: 'directory';
    mtimeMs: number;
}

type FsNode = FileNode | DirNode;

class MemoryFileHandle implements FileHandle {
    private node: FileNode;

    constructor(node: FileNode) {
        this.node = node;
    }

    read(buffer: Uint8Array, offset: number): number {
        const available = Math.max(0, this.node.data.length - offset);
        if (available === 0) return 0;
        const readLen = Math.min(buffer.length, available);
        buffer.set(this.node.data.subarray(offset, offset + readLen));
        return readLen;
    }

    write(data: Uint8Array, offset: number): number {
        const needed = offset + data.length;
        if (needed > this.node.data.length) {
            // Grow the buffer
            const newData = new Uint8Array(needed);
            newData.set(this.node.data);
            this.node.data = newData;
        }
        this.node.data.set(data, offset);
        this.node.mtimeMs = Date.now();
        return data.length;
    }

    getSize(): number {
        return this.node.data.length;
    }

    truncate(size: number): void {
        if (size < this.node.data.length) {
            this.node.data = this.node.data.slice(0, size);
        } else if (size > this.node.data.length) {
            const newData = new Uint8Array(size);
            newData.set(this.node.data);
            this.node.data = newData;
        }
        this.node.mtimeMs = Date.now();
    }

    flush(): void {
        // No-op for in-memory
    }

    close(): void {
        // No-op for in-memory
    }
}

/**
 * In-memory filesystem backed by a Map.
 *
 * Paths are normalized with '/' as root. All parent directories are
 * created implicitly when files are created.
 */
export class MemoryFilesystemProvider implements FilesystemProvider {
    private nodes = new Map<string, FsNode>();

    async initialize(): Promise<void> {
        // Ensure root exists
        this.nodes.set('/', { type: 'directory', mtimeMs: Date.now() });
    }

    private normalize(path: string): string {
        return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    }

    private ensureParentDirs(path: string): void {
        const parts = path.split('/').filter(p => p);
        let current = '';
        for (const part of parts.slice(0, -1)) {
            current += '/' + part;
            const normalized = this.normalize(current);
            if (!this.nodes.has(normalized)) {
                this.nodes.set(normalized, { type: 'directory', mtimeMs: Date.now() });
            }
        }
    }

    async stat(path: string): Promise<FileStat | null> {
        const normalized = this.normalize(path);
        const node = this.nodes.get(normalized);
        if (!node) return null;

        if (node.type === 'directory') {
            return { type: 'directory', size: 0, mtimeMs: node.mtimeMs };
        }
        return { type: 'file', size: node.data.length, mtimeMs: node.mtimeMs };
    }

    async open(path: string, options: OpenOptions = {}): Promise<FileHandle> {
        const normalized = this.normalize(path);

        if (options.directory) {
            const node = this.nodes.get(normalized);
            if (!node || node.type !== 'directory') {
                throw new Error(`Not a directory: ${path}`);
            }
            // Return a dummy handle for directory opens
            return new MemoryFileHandle({ type: 'file', data: new Uint8Array(0), mtimeMs: Date.now() });
        }

        let node = this.nodes.get(normalized);

        if (!node && options.create) {
            this.ensureParentDirs(normalized);
            node = { type: 'file', data: new Uint8Array(0), mtimeMs: Date.now() };
            this.nodes.set(normalized, node);
        }

        if (!node || node.type !== 'file') {
            throw new Error(`File not found: ${path}`);
        }

        if (options.exclusive && this.nodes.has(normalized)) {
            throw new Error(`File already exists: ${path}`);
        }

        if (options.truncate) {
            node.data = new Uint8Array(0);
            node.mtimeMs = Date.now();
        }

        return new MemoryFileHandle(node);
    }

    async mkdir(path: string, recursive?: boolean): Promise<void> {
        const normalized = this.normalize(path);
        if (this.nodes.has(normalized)) return;

        if (recursive) {
            this.ensureParentDirs(normalized + '/dummy');
        }
        this.nodes.set(normalized, { type: 'directory', mtimeMs: Date.now() });
    }

    async readdir(path: string): Promise<DirEntry[]> {
        const normalized = this.normalize(path);
        const prefix = normalized === '/' ? '/' : normalized + '/';
        const entries: DirEntry[] = [];

        for (const [nodePath, node] of this.nodes) {
            if (nodePath === normalized) continue;
            if (!nodePath.startsWith(prefix)) continue;

            // Only direct children
            const rest = nodePath.substring(prefix.length);
            if (rest.includes('/')) continue;

            entries.push({
                name: rest,
                type: node.type === 'directory' ? 'directory' : 'file',
            });
        }

        return entries;
    }

    async unlink(path: string): Promise<void> {
        const normalized = this.normalize(path);
        this.nodes.delete(normalized);
    }

    async rmdir(path: string): Promise<void> {
        const normalized = this.normalize(path);
        // Remove the directory and all contents
        const prefix = normalized === '/' ? '/' : normalized + '/';
        const toDelete: string[] = [normalized];
        for (const nodePath of this.nodes.keys()) {
            if (nodePath.startsWith(prefix)) {
                toDelete.push(nodePath);
            }
        }
        for (const p of toDelete) {
            this.nodes.delete(p);
        }
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const oldNorm = this.normalize(oldPath);
        const newNorm = this.normalize(newPath);

        const node = this.nodes.get(oldNorm);
        if (!node) throw new Error(`Not found: ${oldPath}`);

        this.ensureParentDirs(newNorm);
        this.nodes.set(newNorm, node);
        this.nodes.delete(oldNorm);
    }
}
