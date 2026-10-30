import { z } from 'zod';

/**
 * Runs in the browser before the application's modules (Next's `instrumentation-client` convention).
 *
 * Zod's JIT object parser probes `Function('')` when a schema is created. The app's CSP deliberately has no
 * 'unsafe-eval', so the browser reports that probe as a violation even though Zod handles the refusal. The JIT only
 * speeds up very large payloads, so it is switched off to keep the CSP report stream free of noise.
 */
z.config({ jitless: true });
