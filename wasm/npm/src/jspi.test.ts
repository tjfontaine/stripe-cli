import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { detectJSPI, wrapSuspending, wrapPromising } from './jspi.js';

describe('jspi', () => {
    const WA = WebAssembly as typeof WebAssembly & {
        Suspending?: unknown;
        promising?: unknown;
    };

    let originalSuspending: unknown;
    let originalPromising: unknown;

    beforeEach(() => {
        originalSuspending = WA.Suspending;
        originalPromising = WA.promising;
    });

    afterEach(() => {
        (WA as any).Suspending = originalSuspending;
        (WA as any).promising = originalPromising;
    });

    describe('detectJSPI', () => {
        it('returns false when neither Suspending nor promising are defined', () => {
            delete (WA as any).Suspending;
            delete (WA as any).promising;
            // Re-import would be needed to test the module-level const,
            // but detectJSPI() is a function that checks at call time
            expect(detectJSPI()).toBe(false);
        });

        it('returns true when Suspending is defined', () => {
            (WA as any).Suspending = class {};
            expect(detectJSPI()).toBe(true);
        });

        it('returns true when promising is defined', () => {
            delete (WA as any).Suspending;
            (WA as any).promising = () => {};
            expect(detectJSPI()).toBe(true);
        });
    });

    describe('wrapSuspending', () => {
        it('returns original function when JSPI unavailable', () => {
            delete (WA as any).Suspending;
            const fn = () => 42;
            expect(wrapSuspending(fn)).toBe(fn);
        });
    });

    describe('wrapPromising', () => {
        it('returns original function when JSPI unavailable', () => {
            delete (WA as any).promising;
            const fn = () => 42;
            expect(wrapPromising(fn)).toBe(fn);
        });
    });
});
