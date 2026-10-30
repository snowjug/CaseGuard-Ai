import type { Metadata } from 'next';
import { SkillLibraryPage } from '../../../features/skills/SkillLibraryPage';

export const metadata: Metadata = { title: 'SkillDNA Library' };

export default function Page() {
  return <SkillLibraryPage />;
}
