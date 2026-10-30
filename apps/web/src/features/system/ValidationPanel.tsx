'use client';

import type { SystemHealth } from '@caseguard/schemas';
import { Notice, Panel } from '@caseguard/ui';
import { humanize, useSystemStyles } from './styles';

/** The API's own "this dependency is a stand-in" sentences repeat what the table already says per row. */
const STAND_IN_SENTENCE = /^Dependency ".*" is an in-process or synthetic stand-in/;

/**
 * "What is real here": separates the simulated stand-ins (derived from what the API reports) from the integrations
 * that exist in the code but were validated against mocks only. It never says a Azure service works because it was
 * configured; the statements are the build's own validation status.
 */
export function ValidationPanel({ health }: { health: SystemHealth }) {
  const styles = useSystemStyles();
  const standIns = health.dependencies.filter((dependency) => dependency.simulated);
  const apiNotices = health.notices.filter((notice) => !STAND_IN_SENTENCE.test(notice));
  return (
    <Panel
      title="What is real here"
      description="Read this before presenting: what runs for real, and what is a stand-in."
      help="CaseGuard is honest about its integrations. A simulated stand-in is code that runs inside the API in place of a cloud service. An integration that is implemented but validated against mocks only has not been exercised against the live service."
    >
      <Notice variant="info" title="Validation status">
        Azure OpenAI, Microsoft Entra ID sign-in, Azure Blob Storage, Azure AI Search and Azure
        Monitor are implemented, and were validated against mocks or locally generated test data
        only. No live Azure service was called to produce anything you see here.
      </Notice>
      <div className={styles.band}>
        <div className={styles.stack}>
          <p className={styles.text}>
            <strong>Simulated stand-ins in this environment</strong>
          </p>
          {standIns.length > 0 ? (
            <ul className={styles.bullets} aria-label="Simulated stand-ins">
              {standIns.map((dependency) => (
                <li key={dependency.name}>
                  <strong>{humanize(dependency.name)}:</strong> {dependency.detail}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.text}>
              The API reports no stand-ins: every dependency is a configured service.
            </p>
          )}
        </div>
        <div className={styles.stack}>
          <p className={styles.text}>
            <strong>Not exercised against a live service</strong>
          </p>
          <ul className={styles.bullets} aria-label="Integrations not exercised live">
            <li>Azure OpenAI: implemented, validated against mocks only.</li>
            <li>Microsoft Entra ID: implemented, validated with locally generated keys only.</li>
            <li>
              Azure Blob Storage and Azure AI Search: implemented, validated against mocks only.
            </li>
            <li>
              PostgreSQL: local runs use PGlite, an in-process PostgreSQL. The server path (pooling,
              TLS, Entra token authentication) was not exercised by the automated tests.
            </li>
          </ul>
        </div>
      </div>
      {apiNotices.length > 0 ? (
        <div className={styles.stack}>
          <p className={styles.text}>
            <strong>What the API reports about this environment</strong>
          </p>
          <ul className={styles.bullets} aria-label="Notices from the API">
            {apiNotices.map((notice) => (
              <li key={notice}>{notice}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </Panel>
  );
}
