'use client';

import { DeleteAccount } from '@/components/account/delete-account';
import { RequireAuth } from '@/components/layout/require-auth';

export default function DeleteAccountPage() {
  return (
    <RequireAuth>
      <DeleteAccount />
    </RequireAuth>
  );
}
