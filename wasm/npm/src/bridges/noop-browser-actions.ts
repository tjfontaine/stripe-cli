/**
 * No-op browser actions implementation.
 *
 * Logs URLs to the console instead of opening them. Useful as a default
 * when no browser UI is available (e.g. Node.js, headless workers).
 */

import type { BrowserActions } from './types.js';

/**
 * Browser actions that log URLs to the console.
 */
export class NoopBrowserActions implements BrowserActions {
    openUrl(url: string): void {
        console.log(`[stripe-cli-wasm] Open URL: ${url}`);
    }
}
