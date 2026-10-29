import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { createJsonSchemaTransform } from 'fastify-type-provider-zod';
import type { Infrastructure } from '../infrastructure';

export const OPENAPI_PATH = '/api/v1/openapi.json';
export const DOCS_PATH = '/api/docs';

/** The OpenAPI document is generated from the same Zod schemas that validate requests and responses. */
export async function registerOpenApi(
  app: FastifyInstance,
  infra: Pick<Infrastructure, 'config'>,
): Promise<void> {
  const { runtime } = infra.config;

  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'CaseGuard AI API',
        version: runtime.version,
        description:
          'Evidence-grounded, counterfactual quality analysis for technical-support cases. ' +
          'All data in the demonstration environment is synthetic.',
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'Microsoft Entra ID access token (AUTH_MODE=entra).',
          },
          devPersona: {
            type: 'apiKey',
            in: 'header',
            name: 'x-cg-persona',
            description:
              'Development persona id. Only accepted when AUTH_MODE=dev and DEV_AUTH_ENABLED=true.',
          },
        },
      },
    },
    transform: createJsonSchemaTransform({ zodToJsonConfig: { unrepresentable: 'any' } }),
  });

  // The route table is useful to developers and uninteresting to attackers, but there is no reason to
  // serve it from a deployed environment.
  if (runtime.deployed) return;

  app.get(OPENAPI_PATH, { schema: { hide: true } }, () => app.swagger());
  await app.register(swaggerUi, {
    routePrefix: DOCS_PATH,
    staticCSP: true,
    uiConfig: { docExpansion: 'list', deepLinking: false },
  });
}
