/**
 * WASI Preview1 syscall implementations for Go WASM modules.
 *
 * All filesystem operations are delegated to a FilesystemProvider, making this
 * module independent of any specific storage backend (OPFS, in-memory, etc.).
 *
 * Async filesystem operations are wrapped with JSPI when available, allowing
 * the WASM stack to suspend while JavaScript awaits.
 */

import type { FilesystemProvider, FileHandle } from './fs/types.js';
import { wrapSuspending } from './jspi.js';

// ============================================================================
// WASI Constants
// ============================================================================

export const ERRNO = {
    SUCCESS:   0,
    BADF:      8,
    EXIST:    20,
    INVAL:    28,
    ISDIR:    31,
    NOENT:    44,
    NOSYS:    52,
    NOTDIR:   54,
    NOTEMPTY: 55,
    NXIO:     60,
} as const;

const FILETYPE = {
    UNKNOWN:          0,
    BLOCK_DEVICE:     1,
    CHARACTER_DEVICE: 2,
    DIRECTORY:        3,
    REGULAR_FILE:     4,
    SYMLINK:          7,
} as const;

const OFLAGS = {
    CREAT:     1,
    DIRECTORY: 2,
    EXCL:      4,
    TRUNC:     8,
} as const;

const WHENCE = {
    SET: 0,
    CUR: 1,
    END: 2,
} as const;

// ============================================================================
// GoWasmExit — thrown by proc_exit to unwind the WASM stack
// ============================================================================

export class GoWasmExit extends Error {
    exitError = true as const;
    code: number;
    constructor(code: number) {
        super(`Go WASM exited with code ${code}`);
        this.code = code;
    }
}

// ============================================================================
// File Descriptor Table
// ============================================================================

export interface FdEntry {
    type: 'stdio' | 'file' | 'dir' | 'preopen';
    /** Normalized path (empty string for root). */
    path: string;
    /** Display path for preopens. */
    preopenPath?: string;
    /** Seek offset for files. */
    offset: number;
    /** Open file handle from the FilesystemProvider. */
    fileHandle?: FileHandle;
    /** Cached file size. */
    size?: number;
    /** Directory entries for readdir iteration. */
    dirEntries?: Array<{ name: string; type: number }>;
    /** readdir cookie tracking. */
    dirCookie?: number;
}

export interface FdTable {
    fds: Map<number, FdEntry>;
    nextFd: number;
    alloc(entry: FdEntry): number;
    get(fd: number): FdEntry | undefined;
    delete(fd: number): void;
}

export function createFdTable(): FdTable {
    const fds = new Map<number, FdEntry>();
    let nextFd = 4; // 0=stdin, 1=stdout, 2=stderr, 3=preopen root

    // Initialize stdio and preopen
    fds.set(0, { type: 'stdio', path: '', offset: 0 });
    fds.set(1, { type: 'stdio', path: '', offset: 0 });
    fds.set(2, { type: 'stdio', path: '', offset: 0 });
    fds.set(3, { type: 'preopen', path: '', preopenPath: '/', offset: 0 });

    return {
        fds,
        nextFd,
        alloc(entry: FdEntry): number {
            const fd = nextFd++;
            fds.set(fd, entry);
            return fd;
        },
        get(fd: number): FdEntry | undefined {
            return fds.get(fd);
        },
        delete(fd: number): void {
            fds.delete(fd);
        },
    };
}

// ============================================================================
// Config for WASI syscall creation
// ============================================================================

export interface WasiConfig {
    args: string[];
    env: [string, string][];
    cwd: string;
    stdoutWrite: (data: Uint8Array) => void;
    stderrWrite: (data: Uint8Array) => void;
}

// ============================================================================
// Factory: create WASI Preview1 imports
// ============================================================================

/**
 * Create the `wasi_snapshot_preview1` import object for a Go WASM module.
 *
 * @param getMem Function returning the current WASM memory ArrayBuffer
 * @param fdTable File descriptor table (shared with the loader for cleanup)
 * @param fs FilesystemProvider implementation
 * @param config WASI configuration (args, env, stdio callbacks)
 * @param jspi Whether JSPI is available (wraps async functions with Suspending)
 * @returns Import object entries for `wasi_snapshot_preview1`
 */
export function createWasiImports(
    getMem: () => ArrayBuffer,
    fdTable: FdTable,
    fs: FilesystemProvider,
    config: WasiConfig,
    jspi: boolean,
): Record<string, Function> {
    const textDecoder = new TextDecoder();
    const textEncoder = new TextEncoder();

    // Encode args and env upfront
    const argBytes = config.args.map(a => textEncoder.encode(a + '\0'));
    const totalArgSize = argBytes.reduce((s, b) => s + b.length, 0);

    const defaultEnv: [string, string][] = [
        ['HOME', config.cwd || '/'],
        ['STRIPE_CLI_TELEMETRY_OPTOUT', 'true'],
    ];
    const allEnv = [...defaultEnv, ...config.env];
    const envPairs = allEnv.map(([k, v]) => textEncoder.encode(k + '=' + v + '\0'));
    const totalEnvSize = envPairs.reduce((s, b) => s + b.length, 0);

    const preopenPathBytes = textEncoder.encode('/');

    // Helper: read string from WASM memory
    function readString(ptr: number, len: number): string {
        return textDecoder.decode(new Uint8Array(getMem(), ptr, len));
    }

    // Helper: resolve path relative to a directory fd
    function resolvePath(dirFd: number, subpath: string): string {
        const dirEntry = fdTable.get(dirFd);
        if (!dirEntry) return subpath;
        const base = dirEntry.path;
        if (!base) return subpath;
        return base + '/' + subpath;
    }

    // Helper: normalize path (remove double slashes, etc.)
    function normalizePath(p: string): string {
        return p.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
    }

    // Helper: write filestat structure
    function writeFilestat(
        view: DataView, ptr: number,
        filetype: number, size: number, mtimeMs: number,
    ): void {
        view.setBigUint64(ptr, 0n, true);       // dev
        view.setBigUint64(ptr + 8, 0n, true);   // ino
        view.setUint8(ptr + 16, filetype);       // filetype
        view.setBigUint64(ptr + 24, 1n, true);  // nlink
        view.setBigUint64(ptr + 32, BigInt(size), true);  // size
        const ns = BigInt(mtimeMs) * 1000000n;
        view.setBigUint64(ptr + 40, ns, true);   // atim
        view.setBigUint64(ptr + 48, ns, true);   // mtim
        view.setBigUint64(ptr + 56, ns, true);   // ctim
    }

    // ========================================================================
    // Async filesystem operations
    // ========================================================================

    async function asyncPathOpen(
        dirfd: number, _dirflags: number,
        pathPtr: number, pathLen: number,
        oflags: number, _rightsBase: bigint, _rightsInheriting: bigint,
        _fdflags: number, fdPtr: number,
    ): Promise<number> {
        const subpath = readString(pathPtr, pathLen);
        const rawPath = resolvePath(dirfd, subpath);
        const normalizedPath = normalizePath(rawPath);

        const wantCreate = (oflags & OFLAGS.CREAT) !== 0;
        const wantDirectory = (oflags & OFLAGS.DIRECTORY) !== 0;
        const wantExcl = (oflags & OFLAGS.EXCL) !== 0;
        const wantTrunc = (oflags & OFLAGS.TRUNC) !== 0;

        try {
            const stat = await fs.stat(normalizedPath);

            if (stat) {
                if (wantExcl && wantCreate) return ERRNO.EXIST;

                if (stat.type === 'directory') {
                    const fd = fdTable.alloc({ type: 'dir', path: normalizedPath, offset: 0 });
                    new DataView(getMem()).setUint32(fdPtr, fd, true);
                    return ERRNO.SUCCESS;
                }

                // Regular file
                if (wantDirectory) return ERRNO.NOTDIR;

                const fileHandle = await fs.open(normalizedPath, {
                    truncate: wantTrunc,
                });

                const fd = fdTable.alloc({
                    type: 'file', path: normalizedPath, offset: 0,
                    fileHandle, size: wantTrunc ? 0 : stat.size,
                });
                new DataView(getMem()).setUint32(fdPtr, fd, true);
                return ERRNO.SUCCESS;
            }

            // Entry doesn't exist
            if (!wantCreate) return ERRNO.NOENT;

            if (wantDirectory) {
                await fs.mkdir(normalizedPath, true);
                const fd = fdTable.alloc({ type: 'dir', path: normalizedPath, offset: 0 });
                new DataView(getMem()).setUint32(fdPtr, fd, true);
                return ERRNO.SUCCESS;
            }

            // Create file
            const fileHandle = await fs.open(normalizedPath, { create: true });
            const fd = fdTable.alloc({
                type: 'file', path: normalizedPath, offset: 0,
                fileHandle, size: 0,
            });
            new DataView(getMem()).setUint32(fdPtr, fd, true);
            return ERRNO.SUCCESS;
        } catch (e) {
            console.error('[wasi-p1] path_open error:', normalizedPath, e);
            return ERRNO.NOENT;
        }
    }

    async function asyncPathCreateDirectory(
        dirfd: number, pathPtr: number, pathLen: number,
    ): Promise<number> {
        const subpath = readString(pathPtr, pathLen);
        const rawPath = resolvePath(dirfd, subpath);
        const normalizedPath = normalizePath(rawPath);

        try {
            const existing = await fs.stat(normalizedPath);
            if (existing && existing.type === 'directory') return ERRNO.EXIST;
            await fs.mkdir(normalizedPath, true);
            return ERRNO.SUCCESS;
        } catch (e) {
            console.error('[wasi-p1] path_create_directory error:', normalizedPath, e);
            return ERRNO.NOENT;
        }
    }

    async function asyncPathFilestatGet(
        dirfd: number, _flags: number, pathPtr: number, pathLen: number, retPtr: number,
    ): Promise<number> {
        const subpath = readString(pathPtr, pathLen);
        const rawPath = resolvePath(dirfd, subpath);
        const normalizedPath = normalizePath(rawPath);
        const view = new DataView(getMem());

        try {
            const stat = await fs.stat(normalizedPath);
            if (!stat) return ERRNO.NOENT;

            if (stat.type === 'directory') {
                writeFilestat(view, retPtr, FILETYPE.DIRECTORY, 0, stat.mtimeMs);
            } else {
                writeFilestat(view, retPtr, FILETYPE.REGULAR_FILE, stat.size, stat.mtimeMs);
            }
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.NOENT;
        }
    }

    async function asyncPathUnlinkFile(
        dirfd: number, pathPtr: number, pathLen: number,
    ): Promise<number> {
        const subpath = readString(pathPtr, pathLen);
        const rawPath = resolvePath(dirfd, subpath);
        const normalizedPath = normalizePath(rawPath);

        try {
            await fs.unlink(normalizedPath);
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.NOENT;
        }
    }

    async function asyncPathRemoveDirectory(
        dirfd: number, pathPtr: number, pathLen: number,
    ): Promise<number> {
        const subpath = readString(pathPtr, pathLen);
        const rawPath = resolvePath(dirfd, subpath);
        const normalizedPath = normalizePath(rawPath);

        try {
            await fs.rmdir(normalizedPath);
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.NOENT;
        }
    }

    async function asyncPathRename(
        oldDirfd: number, oldPathPtr: number, oldPathLen: number,
        newDirfd: number, newPathPtr: number, newPathLen: number,
    ): Promise<number> {
        const oldSubpath = readString(oldPathPtr, oldPathLen);
        const newSubpath = readString(newPathPtr, newPathLen);
        const oldPath = normalizePath(resolvePath(oldDirfd, oldSubpath));
        const newPath = normalizePath(resolvePath(newDirfd, newSubpath));

        try {
            await fs.rename(oldPath, newPath);
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.NOENT;
        }
    }

    async function asyncFdReaddir(
        fd: number, bufPtr: number, bufLen: number, cookie: bigint, retPtr: number,
    ): Promise<number> {
        const entry = fdTable.get(fd);
        if (!entry || (entry.type !== 'dir' && entry.type !== 'preopen')) return ERRNO.BADF;

        const view = new DataView(getMem());
        const u8 = new Uint8Array(getMem());
        const startCookie = Number(cookie);

        try {
            // Lazily load directory entries
            if (!entry.dirEntries || entry.dirCookie !== startCookie) {
                const entries = await fs.readdir(entry.path || '/');
                entry.dirEntries = entries.map(e => ({
                    name: e.name,
                    type: e.type === 'directory' ? FILETYPE.DIRECTORY : FILETYPE.REGULAR_FILE,
                }));
            }

            let offset = 0;
            for (let i = startCookie; i < entry.dirEntries.length; i++) {
                const de = entry.dirEntries[i];
                const nameBytes = textEncoder.encode(de.name);
                // dirent: d_next(8) + d_ino(8) + d_namlen(4) + d_type(1) = 24 bytes + name
                const entrySize = 24 + nameBytes.length;

                if (offset + entrySize > bufLen) break;

                const base = bufPtr + offset;
                view.setBigUint64(base, BigInt(i + 1), true); // d_next
                view.setBigUint64(base + 8, 0n, true);        // d_ino
                view.setUint32(base + 16, nameBytes.length, true); // d_namlen
                view.setUint8(base + 20, de.type);                 // d_type
                u8.set(nameBytes, base + 24);
                offset += entrySize;
            }

            view.setUint32(retPtr, offset, true);
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.BADF;
        }
    }

    async function asyncFdFilestatGet(fd: number, retPtr: number): Promise<number> {
        const entry = fdTable.get(fd);
        if (!entry) return ERRNO.BADF;

        const view = new DataView(getMem());

        if (entry.type === 'stdio') {
            writeFilestat(view, retPtr, FILETYPE.CHARACTER_DEVICE, 0, 0);
            return ERRNO.SUCCESS;
        }

        if (entry.type === 'dir' || entry.type === 'preopen') {
            writeFilestat(view, retPtr, FILETYPE.DIRECTORY, 0, Date.now());
            return ERRNO.SUCCESS;
        }

        // File: get real size
        if (entry.fileHandle) {
            const size = entry.fileHandle.getSize();
            writeFilestat(view, retPtr, FILETYPE.REGULAR_FILE, size, Date.now());
            return ERRNO.SUCCESS;
        }

        try {
            const stat = await fs.stat(entry.path);
            if (stat) {
                writeFilestat(view, retPtr, FILETYPE.REGULAR_FILE, stat.size, stat.mtimeMs);
            } else {
                writeFilestat(view, retPtr, FILETYPE.REGULAR_FILE, entry.size || 0, Date.now());
            }
            return ERRNO.SUCCESS;
        } catch {
            return ERRNO.BADF;
        }
    }

    async function asyncFdRead(
        fd: number, iovs: number, niovs: number, nreadPtr: number,
    ): Promise<number> {
        if (fd <= 2) {
            // stdin: return EOF
            new DataView(getMem()).setUint32(nreadPtr, 0, true);
            return ERRNO.SUCCESS;
        }

        const entry = fdTable.get(fd);
        if (!entry || entry.type !== 'file') return ERRNO.BADF;

        const view = new DataView(getMem());
        let totalRead = 0;

        if (entry.fileHandle) {
            for (let i = 0; i < niovs; i++) {
                const ptr = view.getUint32(iovs + i * 8, true);
                const len = view.getUint32(iovs + i * 8 + 4, true);
                if (len === 0) continue;

                const buf = new Uint8Array(getMem(), ptr, len);
                const bytesRead = entry.fileHandle.read(buf, entry.offset);
                entry.offset += bytesRead;
                totalRead += bytesRead;
                if (bytesRead < len) break; // EOF
            }
        } else {
            // No file handle — shouldn't happen with proper open()
            return ERRNO.BADF;
        }

        view.setUint32(nreadPtr, totalRead, true);
        return ERRNO.SUCCESS;
    }

    async function asyncFdWrite(
        fd: number, iovs: number, niovs: number, nwrittenPtr: number,
    ): Promise<number> {
        const view = new DataView(getMem());

        // stdio: delegate to config callbacks
        if (fd === 1 || fd === 2) {
            let written = 0;
            for (let i = 0; i < niovs; i++) {
                const ptr = view.getUint32(iovs + i * 8, true);
                const len = view.getUint32(iovs + i * 8 + 4, true);
                if (len === 0) continue;
                const bytes = new Uint8Array(getMem(), ptr, len);
                if (fd === 1) config.stdoutWrite(bytes);
                else config.stderrWrite(bytes);
                written += len;
            }
            view.setUint32(nwrittenPtr, written, true);
            return ERRNO.SUCCESS;
        }

        const entry = fdTable.get(fd);
        if (!entry || entry.type !== 'file') return ERRNO.BADF;

        let totalWritten = 0;

        if (entry.fileHandle) {
            for (let i = 0; i < niovs; i++) {
                const ptr = view.getUint32(iovs + i * 8, true);
                const len = view.getUint32(iovs + i * 8 + 4, true);
                if (len === 0) continue;

                const buf = new Uint8Array(getMem(), ptr, len);
                const bytesWritten = entry.fileHandle.write(buf, entry.offset);
                entry.offset += bytesWritten;
                totalWritten += bytesWritten;
            }
            entry.fileHandle.flush();
            entry.size = entry.fileHandle.getSize();
        } else {
            return ERRNO.BADF;
        }

        view.setUint32(nwrittenPtr, totalWritten, true);
        return ERRNO.SUCCESS;
    }

    // ========================================================================
    // Synchronous WASI syscalls
    // ========================================================================

    const wasi: Record<string, Function> = {
        args_get(argv_ptr: number, buf_ptr: number): number {
            const view = new DataView(getMem());
            const u8 = new Uint8Array(getMem());
            let offset = buf_ptr;
            for (let i = 0; i < config.args.length; i++) {
                view.setUint32(argv_ptr + i * 4, offset, true);
                u8.set(argBytes[i], offset);
                offset += argBytes[i].length;
            }
            return ERRNO.SUCCESS;
        },

        args_sizes_get(argc_ptr: number, size_ptr: number): number {
            const v = new DataView(getMem());
            v.setUint32(argc_ptr, config.args.length, true);
            v.setUint32(size_ptr, totalArgSize, true);
            return ERRNO.SUCCESS;
        },

        environ_get(env_ptr: number, buf_ptr: number): number {
            const view = new DataView(getMem());
            const u8 = new Uint8Array(getMem());
            let offset = buf_ptr;
            for (let i = 0; i < envPairs.length; i++) {
                view.setUint32(env_ptr + i * 4, offset, true);
                u8.set(envPairs[i], offset);
                offset += envPairs[i].length;
            }
            return ERRNO.SUCCESS;
        },

        environ_sizes_get(count_ptr: number, size_ptr: number): number {
            const v = new DataView(getMem());
            v.setUint32(count_ptr, envPairs.length, true);
            v.setUint32(size_ptr, totalEnvSize, true);
            return ERRNO.SUCCESS;
        },

        clock_time_get(_id: number, _precision: bigint, time_ptr: number): number {
            new DataView(getMem()).setBigUint64(
                time_ptr, BigInt(Date.now()) * 1000000n, true,
            );
            return ERRNO.SUCCESS;
        },

        fd_prestat_get(fd: number, retPtr: number): number {
            const entry = fdTable.get(fd);
            if (!entry || entry.type !== 'preopen') return ERRNO.BADF;
            const view = new DataView(getMem());
            view.setUint8(retPtr, 0); // tag: directory
            view.setUint32(retPtr + 4, preopenPathBytes.length, true);
            return ERRNO.SUCCESS;
        },

        fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
            const entry = fdTable.get(fd);
            if (!entry || entry.type !== 'preopen') return ERRNO.BADF;
            const u8 = new Uint8Array(getMem());
            const bytes = preopenPathBytes.subarray(0, pathLen);
            u8.set(bytes, pathPtr);
            return ERRNO.SUCCESS;
        },

        fd_fdstat_get(fd: number, ptr: number): number {
            const entry = fdTable.get(fd);
            if (!entry) return ERRNO.BADF;

            const v = new DataView(getMem());
            let filetype: number;
            switch (entry.type) {
                case 'stdio': filetype = FILETYPE.CHARACTER_DEVICE; break;
                case 'dir':
                case 'preopen': filetype = FILETYPE.DIRECTORY; break;
                case 'file': filetype = FILETYPE.REGULAR_FILE; break;
                default: filetype = FILETYPE.UNKNOWN;
            }
            v.setUint8(ptr, filetype);
            v.setUint16(ptr + 2, 0, true); // flags
            v.setBigUint64(ptr + 8, 0xFFFFFFFFFFFFFFFFn, true);  // rights_base
            v.setBigUint64(ptr + 16, 0xFFFFFFFFFFFFFFFFn, true); // rights_inheriting
            return ERRNO.SUCCESS;
        },

        fd_fdstat_set_flags(): number { return ERRNO.SUCCESS; },

        fd_close(fd: number): number {
            const entry = fdTable.get(fd);
            if (!entry) return ERRNO.BADF;
            if (fd <= 2) return ERRNO.SUCCESS; // Don't close stdio

            if (entry.fileHandle) {
                try { entry.fileHandle.close(); } catch { /* ignore */ }
            }

            fdTable.delete(fd);
            return ERRNO.SUCCESS;
        },

        fd_seek(fd: number, offset: bigint, whence: number, newoffsetPtr: number): number {
            const entry = fdTable.get(fd);
            if (!entry || entry.type !== 'file') return ERRNO.BADF;

            const offsetNum = Number(offset);
            let newOffset: number;

            switch (whence) {
                case WHENCE.SET:
                    newOffset = offsetNum;
                    break;
                case WHENCE.CUR:
                    newOffset = entry.offset + offsetNum;
                    break;
                case WHENCE.END: {
                    const size = entry.fileHandle
                        ? entry.fileHandle.getSize()
                        : (entry.size || 0);
                    newOffset = size + offsetNum;
                    break;
                }
                default:
                    return ERRNO.INVAL;
            }

            entry.offset = Math.max(0, newOffset);
            new DataView(getMem()).setBigUint64(newoffsetPtr, BigInt(entry.offset), true);
            return ERRNO.SUCCESS;
        },

        fd_sync(fd: number): number {
            const entry = fdTable.get(fd);
            if (entry?.fileHandle) {
                entry.fileHandle.flush();
            }
            return ERRNO.SUCCESS;
        },

        fd_filestat_set_size(fd: number, size: bigint): number {
            const entry = fdTable.get(fd);
            if (!entry || entry.type !== 'file') return ERRNO.BADF;

            if (entry.fileHandle) {
                entry.fileHandle.truncate(Number(size));
                entry.fileHandle.flush();
                entry.size = Number(size);
            }
            return ERRNO.SUCCESS;
        },

        fd_pread(): number { return ERRNO.NOSYS; },
        fd_pwrite(): number { return ERRNO.NOSYS; },

        path_filestat_set_times(): number { return ERRNO.SUCCESS; },
        path_readlink(): number { return ERRNO.NOENT; },
        path_symlink(): number { return ERRNO.NOSYS; },

        poll_oneoff(
            _in_ptr: number, _out_ptr: number,
            _nsubs: number, nevents_ptr: number,
        ): number {
            new DataView(getMem()).setUint32(nevents_ptr, 0, true);
            return ERRNO.SUCCESS;
        },

        proc_exit(code: number): void {
            // Close all file descriptors before exit
            for (const [fd, entry] of fdTable.fds) {
                if (fd > 2 && entry.fileHandle) {
                    try { entry.fileHandle.close(); } catch { /* ignore */ }
                }
            }
            throw new GoWasmExit(code);
        },

        random_get(buf: number, len: number): number {
            const arr = new Uint8Array(getMem(), buf, len);
            crypto.getRandomValues(arr);
            return ERRNO.SUCCESS;
        },

        sched_yield(): number { return ERRNO.SUCCESS; },
        sock_accept(): number { return ERRNO.NOSYS; },
        sock_shutdown(): number { return ERRNO.NOSYS; },
    };

    // ========================================================================
    // Wire up async WASI functions — JSPI-wrapped or direct
    // ========================================================================

    const asyncFunctions: Record<string, Function> = {
        path_open: asyncPathOpen,
        path_create_directory: asyncPathCreateDirectory,
        path_filestat_get: asyncPathFilestatGet,
        path_unlink_file: asyncPathUnlinkFile,
        path_remove_directory: asyncPathRemoveDirectory,
        path_rename: asyncPathRename,
        fd_readdir: asyncFdReaddir,
        fd_filestat_get: asyncFdFilestatGet,
        fd_read: asyncFdRead,
        fd_write: asyncFdWrite,
    };

    if (jspi) {
        for (const [name, fn] of Object.entries(asyncFunctions)) {
            wasi[name] = wrapSuspending(fn);
        }
    } else {
        for (const [name, fn] of Object.entries(asyncFunctions)) {
            wasi[name] = fn;
        }
    }

    return wasi;
}
