import { registerHooks } from 'node:module';

/**
 * Teaches plain `node` the `@featherstat/shared` workspace alias that tsc (via
 * `paths`) and vitest (via `resolve.alias`) already know about, so the bench can
 * run outside the test runner. Loaded with `node --import`; see the root
 * `bench` script.
 */
const SHARED = new URL('../../../../packages/shared/src/index.ts', import.meta.url).href;

registerHooks({
  resolve(specifier, context, next) {
    if (specifier !== '@featherstat/shared') return next(specifier, context);
    return { url: SHARED, shortCircuit: true };
  },
});
