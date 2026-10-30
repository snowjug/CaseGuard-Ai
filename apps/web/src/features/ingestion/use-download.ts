'use client';

import { ROUTES, buildPath } from '@caseguard/schemas';
import { useCallback } from 'react';
import { ApiError } from '../../lib/api/errors';
import { useAuth } from '../../lib/auth/context';

export type DownloadTarget =
  | { route: 'schemas.caseBundle' | 'schemas.knowledgePack'; fileName: string }
  | { route: 'examples.get'; exampleId: string; fileName: string };

/**
 * Downloads a file the API serves as an attachment (JSON Schemas, example cases). The request carries the caller's
 * identity headers, which a plain link could not, and the bytes are saved exactly as received (examples may be plain
 * text or CSV, not JSON, so they do not go through the typed JSON client).
 */
export function useDownload(): (target: DownloadTarget) => Promise<void> {
  const auth = useAuth();
  return useCallback(
    async (target) => {
      const path =
        target.route === 'examples.get'
          ? buildPath(ROUTES['examples.get'].path, { exampleId: target.exampleId })
          : ROUTES[target.route].path;
      const headers = await auth.getAuthHeaders();
      const response = await fetch(path, {
        headers: { ...headers, accept: '*/*' },
        credentials: 'same-origin',
      });
      if (!response.ok) {
        throw new ApiError({
          status: response.status,
          code: `http_${response.status}`,
          title: 'Download failed',
          message: `The server answered ${response.status} for ${target.fileName}.`,
        });
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = target.fileName;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    [auth],
  );
}
