'use client';

import { RequireAuth } from '@/components/layout/require-auth';
import { ProfileForm } from '@/components/student/profile-form';
import { ResumeManager } from '@/components/student/resume-manager';

// ต้องเป็นนักศึกษา — สิทธิ์จริงตรวจที่ Gateway/Lifecycle (RequireAuth เป็นแค่ด่านของหน้าจอ)
export default function StudentProfilePage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
        <h1 className="text-3xl font-semibold">โปรไฟล์และเรซูเม่</h1>
        <p className="mt-2 text-sm text-ink-soft">ข้อมูลนี้บริษัทจะเห็นเมื่อคุณยินยอมตอนสมัครงานเท่านั้น</p>
        <div className="mt-6"><ProfileForm /></div>
        <ResumeManager />
      </main>
    </RequireAuth>
  );
}
