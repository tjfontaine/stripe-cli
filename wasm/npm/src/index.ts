/**
 * stripe-cli-wasm
 *
 * Run the Stripe CLI in the browser via WebAssembly.
 *
 * Usage:
 * ```typescript
 * import { loadStripeCli } from 'stripe-cli-wasm';
 * import { FetchHttpBridge } from 'stripe-cli-wasm/bridges/fetch-http-bridge';
 * import { OpfsFilesystem } from 'stripe-cli-wasm/fs/opfs-provider';
 *
 * const stripe = await loadStripeCli({
 *     wasm: '/path/to/stripe.wasm',
 *     httpBridge: new FetchHttpBridge(),
 *     filesystem: new OpfsFilesystem('/stripe'),
 * });
 *
 * const result = await stripe.run({
 *     args: ['stripe', 'version'],
 *     stdout: (data) => console.log(new TextDecoder().decode(data)),
 *     stderr: (data) => console.error(new TextDecoder().decode(data)),
 * });
 * console.log('exit code:', result.exitCode);
 * ```
 */

export { loadStripeCli } from './go-wasip1-loader.js';
export { GoWasmExit } from './wasi-preview1.js';
export type { StripeCLIConfig, StripeCLIInstance, RunOptions, RunResult } from './types.js';
export type { HttpBridge, WsBridge, BrowserActions } from './bridges/types.js';
export type { FilesystemProvider, FileHandle, FileStat, DirEntry, OpenOptions } from './fs/types.js';
