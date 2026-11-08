import type { Metadata } from 'next';
import { SkillLibraryPage } from '../../../features/skills/SkillLibraryPage';

export const metadata: Metadata = { title: 'Skills' };

export default function Page() {
  return <SkillLibraryPage />;
}
