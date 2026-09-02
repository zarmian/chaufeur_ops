import { z } from 'zod';

/**
 * Stop Zod asking the browser whether it may use `eval`.
 *
 * Zod 4 compiles validators with `new Function` when it can, and finds out
 * whether it can by trying it inside a `try`/`catch`. Under this
 * application's CSP that call is refused, the `catch` runs, and Zod quietly
 * uses its interpreted path — nothing breaks, and booking a job works exactly
 * as it did.
 *
 * What it does leave behind is a `securitypolicyviolation` report on every
 * page carrying a schema. That matters more than it sounds: the CSP smoke
 * test in `tests/e2e/csp.spec.ts` exists to fail on *any* refused request,
 * because the bug it was written for — uploads blocked at `connect-src`, no
 * error, a progress bar stuck at 0% — announced itself no other way. A policy
 * check with a standing exception in it is a policy check nobody reads.
 *
 * So the probe is turned off at the source rather than allowed for in the
 * test. `jitless` makes Zod skip the attempt entirely and go straight to the
 * path it was going to take anyway.
 *
 * **Browser only.** `z.config` is global to the process, and the server has no
 * CSP to trip over — it can go on compiling validators, which is the faster
 * half and the half that runs on every request.
 */
if (typeof window !== 'undefined') {
  z.config({ jitless: true });
}

export {};
