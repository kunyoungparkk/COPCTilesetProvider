import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Resolves this repository's `.js` specifiers to the `.ts` files they mean.
 *
 * `src/` uses `.js` specifiers because NodeNext requires them, and Node's
 * native type stripping does not rewrite them, so a Worker started on a
 * source file fails with ERR_MODULE_NOT_FOUND. This is test-only scaffolding:
 * production loads the Rollup bundle OVERVIEW §5 calls for.
 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    if (specifier.endsWith('.js') && context.parentURL) {
      const asTs = new URL(specifier, context.parentURL);
      asTs.pathname = asTs.pathname.replace(/\.js$/, '.ts');
      if (existsSync(fileURLToPath(asTs))) {
        return next(asTs.href, context);
      }
    }
    throw error;
  }
}
