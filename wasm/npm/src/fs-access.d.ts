/**
 * Type declarations for the File System Access API (Worker context).
 *
 * These are not yet included in TypeScript's standard lib.dom.d.ts
 * but are available in Chrome 102+ and Safari 15.2+ (Workers only).
 */

interface FileSystemSyncAccessHandle {
    read(buffer: ArrayBufferView, options?: { at?: number }): number;
    write(buffer: ArrayBufferView, options?: { at?: number }): number;
    getSize(): number;
    truncate(newSize: number): void;
    flush(): void;
    close(): void;
}

interface FileSystemFileHandle {
    createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
    createWritable(options?: { keepExistingData?: boolean }): Promise<FileSystemWritableFileStream>;
}

interface FileSystemWritableFileStream extends WritableStream {
    write(data: ArrayBuffer | ArrayBufferView | Blob | string | { type: string; data?: ArrayBuffer | ArrayBufferView | Blob | string; position?: number; size?: number }): Promise<void>;
    seek(position: number): Promise<void>;
    truncate(size: number): Promise<void>;
    close(): Promise<void>;
}

interface FileSystemDirectoryHandle {
    entries(): AsyncIterableIterator<[string, FileSystemDirectoryHandle | FileSystemFileHandle]>;
}
