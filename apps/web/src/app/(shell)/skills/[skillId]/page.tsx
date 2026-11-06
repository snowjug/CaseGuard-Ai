import type { Metadata } from 'next';
import { SkillDetailPage } from '../../../../features/skills/SkillDetailPage';

export const metadata: Metadata = { title: 'Skill' };

export default async function Page({ params }: { params: Promise<{ skillId: string }> }) {
  const { skillId } = await params;
  return <SkillDetailPage skillId={skillId} />;
}
