'use client';

import { ButtonLink, Card, cg } from '@caseguard/ui';
import { makeStyles, tokens } from '@fluentui/react-components';
import { FolderPlusIcon, SparklesIcon } from 'lucide-react';
import { ADD_CASE_HREF, SAMPLE_CASE_HREF } from '../../lib/nav';
import { FlowSteps } from '../../components/common/FlowSteps';

const useStyles = makeStyles({
  card: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: cg.space[6],
    textAlign: 'center',
  },
  icon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '64px',
    height: '64px',
    borderRadius: cg.radius.xl,
    backgroundColor: cg.tone.brand.tint,
    color: cg.tone.brand.fg,
    fontSize: tokens.fontSizeHero700,
  },
  title: {
    margin: 0,
    color: cg.text,
    fontSize: tokens.fontSizeHero700,
    lineHeight: tokens.lineHeightHero700,
    fontWeight: tokens.fontWeightSemibold,
    letterSpacing: '-0.02em',
  },
  text: { margin: 0, maxWidth: '52ch', color: cg.textSecondary, fontSize: tokens.fontSizeBase400 },
  actions: { display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: cg.space[3] },
  steps: { width: '100%', textAlign: 'start' },
});

/** Home with no cases: what the product does in three steps, and the two ways to start. */
export function NoCases({ canAdd }: { canAdd: boolean }) {
  const styles = useStyles();
  return (
    <Card as="section" hero glow padding="lg" className={styles.card} aria-labelledby="home-empty">
      <span className={styles.icon} aria-hidden="true">
        <FolderPlusIcon />
      </span>
      <h2 id="home-empty" className={styles.title}>
        {canAdd ? 'Add your first case' : 'No cases yet'}
      </h2>
      <p className={styles.text}>
        {canAdd
          ? 'Paste a support case, upload a file or start from a sample. You get a score, the reason for it and the top fixes in about a minute.'
          : 'There are no cases to show. Someone with the Engineer or Administrator role can add one.'}
      </p>
      {canAdd ? (
        <div className={styles.actions}>
          <ButtonLink href={ADD_CASE_HREF} variant="primary" size="lg" icon={<FolderPlusIcon />}>
            Add a case
          </ButtonLink>
          <ButtonLink href={SAMPLE_CASE_HREF} variant="secondary" size="lg" icon={<SparklesIcon />}>
            Try a sample case
          </ButtonLink>
        </div>
      ) : null}
      <div className={styles.steps}>
        <FlowSteps stage={1} />
      </div>
    </Card>
  );
}
