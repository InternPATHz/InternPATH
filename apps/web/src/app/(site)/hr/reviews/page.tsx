import { HrReviews } from '@/components/hr/reviews/hr-reviews';
import { RequireAuth } from '@/components/layout/require-auth';

export const metadata = { title: 'รีวิวบริษัท' };

export default function HrReviewsPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <HrReviews />
    </RequireAuth>
  );
}
