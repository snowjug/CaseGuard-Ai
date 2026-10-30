import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit, { normalizeIP } from '@fastify/rate-limit';
import type { FastifyInstance } from 'fastify';
import { RateLimitedError } from '../errors';
import type { Infrastructure } from '../infrastructure';
import { clientAddressOf } from './client-address';
import './fastify-types';

/** Parts a legitimate upload needs: one file plus a couple of small text fields. */
const MULTIPART_LIMITS = {
  files: 1,
  fields: 4,
  parts: 6,
  fieldNameSize: 100,
  fieldSize: 2048,
  headerPairs: 50,
} as const;

/**
 * Cross-origin policy, request throttling and upload limits.
 *
 * - CORS is an explicit allow-list (`CORS_ALLOWED_ORIGINS`: `http://localhost:3000` in a local run, required in a
 *   deployed environment, no wildcard; no allowed origin means same-origin only) and never allows credentials;
 *   the API uses bearer tokens, not cookies.
 * - The general limit is per client address and covers every route, probes excepted, and 404s.
 * - Uploads are capped by `UPLOAD_MAX_BYTES`, one file per request.
 */
export async function registerSecurity(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'config' | 'metrics'>,
): Promise<void> {
  const { config, metrics } = infra;

  const allowedHeaders = ['authorization', 'content-type', 'idempotency-key', 'x-request-id'];
  if (config.auth.mode === 'dev' && config.auth.devAuthEnabled) allowedHeaders.push('x-cg-persona');

  await app.register(cors, {
    origin: config.http.corsAllowedOrigins.length > 0 ? [...config.http.corsAllowedOrigins] : false,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders,
    exposedHeaders: ['x-request-id', 'retry-after', 'idempotent-replayed', 'content-disposition'],
    credentials: false,
    maxAge: 600,
  });

  await app.register(rateLimit, {
    global: true,
    max: config.limits.rateLimitMax,
    timeWindow: config.limits.rateLimitWindowMs,
    // One bucket per client address (an IPv6 client counts by its /64, as the plugin's default does).
    keyGenerator: (request) =>
      normalizeIP(clientAddressOf(request, config.http.trustClientIpHeader)),
    errorResponseBuilder: (_request, context) =>
      new RateLimitedError(Math.ceil(context.ttl / 1000)),
    onExceeded: () => metrics.recordRateLimitHit('general'),
  });

  await app.register(multipart, {
    limits: { ...MULTIPART_LIMITS, fileSize: config.http.uploadMaxBytes },
    throwFileSizeLimit: true,
  });
}
