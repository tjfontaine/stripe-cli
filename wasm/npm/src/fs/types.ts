/**
 * Filesystem abstraction for WASI Preview1 operations.
 *
 * The Go WASM binary uses WASI filesystem syscalls (path_open, fd_read, fd_write, etc.)
 * to persist config files (~/.config/stripe/). This interface abstracts the backing store
 * so embedders can provide OPFS, in-memory, Node fs, or custom implementations.
 */

/** File metadata. */
export interface FileStat {
    type: 'file' | 'directory';
    size: number;
    /** Modification time in milliseconds since epoch. */
    mtimeMs: number;
}

/** Options for opening a file. */
export interface OpenOptions {
    /** Create the file if it doesn't exist. */
    create?: boolean;
    /** Fail if the file already exists (requires create). */
    exclusive?: boolean;
    /** Truncate the file to zero length on open. */
    truncate?: boolean;
    /** Open as a directory (for readdir). */
    directory?: boolean;
}

/**
 * A handle to an open file, supporting synchronous read/write operations.
 *
 * Mirrors the shape of FileSystemSyncAccessHandle so OPFS implementations
 * can delegate directly, while in-memory implementations use simple buffers.
 */
export interface FileHandle {
    /** Read into buffer at the given file offset. Returns bytes read. */
    read(buffer: Uint8Array, offset: number): number;
    /** Write data at the given file offset. Returns bytes written. */
    write(data: Uint8Array, offset: number): number;
    /** Get the current file size. */
    getSize(): number;
    /** Truncate or extend the file to the given size. */
    truncate(size: number): void;
    /** Flush any buffered writes to storage. */
    flush(): void;
    /** Close the handle and release resources. */
    close(): void;
}

/** A directory entry. */
export interface DirEntry {
    name: string;
    type: 'file' | 'directory';
}

/**
 * Abstract filesystem provider for the WASI Preview1 layer.
 *
 * All paths are absolute, normalized (no trailing slashes, no double slashes),
 * with '/' as the root. Implementations handle their own path resolution and
 * storage semantics.
 */
export interface FilesystemProvider {
    /** Initialize the filesystem. Called once before any operations. */
    initialize(): Promise<void>;

    /** Check if a path exists and return its metadata, or null if not found. */
    stat(path: string): Promise<FileStat | null>;

    /** Open a file, returning a handle for synchronous read/write operations. */
    open(path: string, options: OpenOptions): Promise<FileHandle>;

    /** Create a directory (and parents if recursive). */
    mkdir(path: string, recursive?: boolean): Promise<void>;

    /** List directory entries. */
    readdir(path: string): Promise<DirEntry[]>;

    /** Remove a file. */
    unlink(path: string): Promise<void>;

    /** Remove a directory. */
    rmdir(path: string): Promise<void>;

    /** Rename/move a file or directory. */
    rename(oldPath: string, newPath: string): Promise<void>;
}
