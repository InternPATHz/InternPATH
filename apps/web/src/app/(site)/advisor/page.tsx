import { RequireAuth } from '@/components/layout/require-auth';
import { AdvisorHome } from '@/components/advisor/advisor-home';

export const metadata = { title: 'ภาพรวมอาจารย์' };

export default function AdvisorHomePage() {
  return <RequireAuth roles={['ADVISOR']}><AdvisorHome /></RequireAuth>;
}
