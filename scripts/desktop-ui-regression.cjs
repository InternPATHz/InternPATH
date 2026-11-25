// Start the web app, then run: WEB_BASE_URL=http://localhost:3100 node scripts/desktop-ui-regression.cjs
// Uses the Playwright dependency already declared by the Lifecycle workspace.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { chromium } = createRequire(resolve(__dirname, '../apps/lifecycle/package.json'))(
  'playwright',
);
const assert = require('node:assert/strict');
const root = process.env.WEB_BASE_URL ?? 'http://localhost:3100';
const viewportWidth = Number(process.env.DESKTOP_WIDTH || 1024);
const id = (i) => '00000000-0000-4000-8000-' + String(i).padStart(12, '0');
const c1 = id(811),
  s1 = id(110),
  s2 = id(111),
  a1 = id(112),
  dt = '2026-11-12T07:00:00Z',
  long = 'ฝึกงาน' + 'N'.repeat(230);
const pageData = (data, total = data.length, page = 1, size = 20) => ({
  data,
  meta: { page, page_size: size, total },
});
const company = {
  id: c1,
  name: long,
  registration_no: '1200000000011',
  status: 'VERIFIED',
  member_role: 'OWNER',
  documents: [],
  members: [],
  email_domain: 'demo.test',
  categories: ['TECH_IT'],
};
const app = {
  id: id(777),
  student_user_id: s1,
  student_name: 'สุดา',
  job_title: 'วิศวกรระบบ',
  company_name: 'บริษัท ก',
  company_id: c1,
  job_id: id(227),
  status: 'EVALUATED_FAIL',
  major_mismatch: false,
  frozen: false,
  created_at: dt,
  status_changed_at: dt,
};
const review = (n) => ({
  id: id(n),
  rating: 4,
  title: 'รีวิว ' + n,
  body: long,
  display_major: 'วิศวกรรม',
  outcome_label: 'PASS',
  display_year: 4,
  published_at: dt,
});
const all = [],
  failures = [];
async function run(browser, name, role, scenario) {
  const ctx = await browser.newContext({ viewport: { width: viewportWidth, height: 820 } }),
    p = await ctx.newPage();
  p.setDefaultTimeout(10000);
  let me = {
    id: s1,
    role,
    email: 'name@campus.test',
    status: 'ACTIVE',
    email_verified: true,
    full_name: 'ชื่อทดสอบ',
    created_at: dt,
    ...(role === 'STUDENT'
      ? {
          student: {
            student_code: '66001',
            major: 'วิศวกรรม',
            year_level: 3,
            advisor_link_status: 'LINKED',
          },
        }
      : role === 'COMPANY_HR'
        ? { company }
        : {}),
  };
  const handlers = [],
    calls = [],
    errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  if (role)
    await p.addInitScript(() => {
      if (!sessionStorage.getItem('qa-init')) {
        sessionStorage.setItem('internpath.refresh_token', 'fixture');
        sessionStorage.setItem('qa-init', '1');
      }
    });
  const at = (method, match, fn) => handlers.unshift([method, match, fn]);
  await p.route('**/api/v1/**', async (route) => {
    const r = route.request(),
      url = new URL(r.url()),
      path = url.pathname.replace('/api/v1', ''),
      method = r.method();
    calls.push({ path, params: url.searchParams, method, body: r.postDataJSON() });
    const h = handlers.find(
      ([m, pat]) => m === method && (typeof pat === 'string' ? pat === path : pat.test(path)),
    );
    let value = h ? await h[2](url, r) : null;
    if (!h) {
      if (path === '/auth/refresh')
        value = { access_token: 'fixture', refresh_token: 'fixture', user: me };
      else if (path === '/users/me') value = me;
      else if (path === '/notifications/unread-count') value = { count: 0 };
      else if (path === '/auth/logout') value = { statusCode: 204 };
      else if (method === 'GET') value = pageData([]);
      else throw new Error('Unexpected fixture mutation ' + method + ' ' + path);
    }
    if (value?.statusCode)
      await route.fulfill({
        status: value.statusCode,
        ...(value.statusCode === 204
          ? {}
          : {
              json: {
                error: {
                  code: value.code || 'STATE_CONFLICT',
                  message: 'ทดสอบ',
                  details: value.details || [],
                },
              },
            }),
      });
    else await route.fulfill({ json: value });
  });
  const check = async (label, fn) => {
    assert.ok(await fn, label);
    all.push(name + ' / ' + label);
  };
  const go = async (path) => {
    await p.goto(root + path);
    await p.locator('h1').first().waitFor();
  };
  try {
    await scenario({ p, at, check, go, calls, me });
    await check('no browser exception', !errors.length);
    await check(
      viewportWidth + 'px fits',
      p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1),
    );
  } catch (e) {
    failures.push([name, e.message]);
    console.error('FAIL', name, e.message);
  } finally {
    await ctx.close();
  }
}
(async () => {
  const b = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL });
  try {
    await Promise.all([
      run(b, 'student review history', 'STUDENT', async ({ p, go, at, check }) => {
        const word = 'ประสบการณ์ทำงานร่วมกับทีม';
        const body = word.repeat(Math.ceil(5000 / word.length)).slice(0, 5000);
        const reviewed = { ...app, id: id(782) };
        const history = [
          {
            id: id(783),
            application_id: reviewed.id,
            company_id: c1,
            rating: 5,
            body,
            anonymous: true,
            status: 'PUBLISHED',
            created_at: dt,
          },
        ];
        at('GET', '/me/applications', () => pageData([app, reviewed]));
        at('GET', '/me/reviews', () => pageData(history));
        at('POST', '/applications/' + app.id + '/review', (_url, request) => {
          history.unshift({
            ...history[0],
            ...request.postDataJSON(),
            id: id(784),
            application_id: app.id,
            status: 'SUBMITTED',
          });
          return { status: 'SUBMITTED' };
        });
        await go('/student/reviews');
        const card = p.locator('li').filter({ has: p.getByRole('link', { name: 'ดูในหน้าบริษัท' }) });
        const disclosure = card.locator('summary');
        await disclosure.waitFor();
        await check('long review starts collapsed', !(await card.getByText(body).isVisible()));
        await disclosure.focus();
        await p.keyboard.press('Enter');
        await check(
          'full 5000-character review opens by keyboard',
          card.getByText(body).isVisible(),
        );
        await p.keyboard.press('Space');
        await check('review collapses by keyboard', !(await card.getByText(body).isVisible()));
        await p.getByRole('button', { name: 'เขียนรีวิว' }).click();
        await check(
          'form describes automatic publication accurately',
          !(await p.getByText(/เผยแพร่ในหน้าบริษัททันที/).count()),
        );
        await p.getByRole('radio', { name: '5 ดาว' }).focus();
        await p.keyboard.press('Space');
        await p.getByRole('textbox', { name: 'เนื้อหา' }).fill('ได้ฝึกกับทีมจริง');
        await p.getByRole('button', { name: 'ส่งรีวิว', exact: true }).click();
        const pending = p.locator('li').filter({ hasText: 'ส่งแล้ว · กำลังเผยแพร่' });
        await pending.waitFor();
        await check(
          'pending review has no public link',
          (await pending.getByRole('link').count()) === 0,
        );
        await check(
          'published review links to correct company',
          (await card.getByRole('link').getAttribute('href')).endsWith(c1),
        );
      }),
      run(b, 'notification count retry', 'STUDENT', async ({ p, go, at, check, calls }) => {
        let count = null;
        at('GET', '/notifications/unread-count', () =>
          count === null ? { statusCode: 503 } : { count },
        );
        at('GET', '/notifications', () =>
          pageData([
            {
              id: a1,
              type: 'application.updated',
              read: true,
              title: 'ใบสมัครที่ติดตาม',
              body: 'รายละเอียด',
              created_at: dt,
            },
          ]),
        );
        await go('/notifications');
        const main = p.getByRole('main');
        await main.getByText('ใบสมัครที่ติดตาม').waitFor();
        const retry = main.getByRole('button', { name: 'ลองโหลดยอดอีกครั้ง' });
        await retry.waitFor();
        const fetchedLists = () => calls.filter((call) => call.path === '/notifications').length;
        const before = fetchedLists();
        await Promise.all([
          p.waitForResponse(
            (response) =>
              response.url().endsWith('/notifications/unread-count') && response.status() === 503,
          ),
          retry.click(),
        ]);
        await retry.waitFor();
        count = 123;
        await retry.click();
        await main.getByRole('button', { name: 'ยังไม่อ่าน (123)' }).waitFor();
        await check('retry fetches only the count', fetchedLists() === before);
        await check('list survives count error', main.getByText('ใบสมัครที่ติดตาม').isVisible());
        await check('retry clears after recovery', !(await retry.count()));
        count = 0;
        await main.getByRole('button', { name: 'ยังไม่อ่าน (123)' }).click();
        await main.getByRole('button', { name: 'ยังไม่อ่าน (0)' }).waitFor();
        await check(
          'zero is a loaded result',
          main.getByRole('button', { name: 'อ่านทั้งหมดแล้ว' }).isDisabled(),
        );
      }),

      run(b, 'account', 'STUDENT', async ({ p, go, check, at, me, calls }) => {
        at('PATCH', '/users/me', (_u, r) => ({ ...me, full_name: r.postDataJSON().full_name }));
        await go('/account#advisor');
        await p.getByRole('button', { name: 'แก้ไขชื่อ' }).click();
        await p.locator('main form input').fill(long);
        await p.getByRole('button', { name: 'บันทึกชื่อ' }).click();
        await p.getByText('บันทึกชื่อแล้ว').waitFor();
        await check(
          'name returned by API rendered',
          p.getByText(long, { exact: true }).first().isVisible(),
        );
        await check('linked advisor journey', p.locator('#advisor a[href="/jobs"]').isVisible());
        await go('/account/delete');
        await check(
          'requires typed confirmation',
          p.getByRole('button', { name: 'ลบบัญชีถาวร' }).isDisabled(),
        );
        let deletion = 0;
        at('POST', '/users/me/deletion-request', () =>
          ++deletion === 1
            ? {
                statusCode: 409,
                code: 'DELETION_BLOCKED',
                details: [{ issue: 'ACTIVE_APPLICATION' }],
              }
            : { statusCode: 204 },
        );
        await p.locator('#delete-confirm').fill('ลบบัญชี');
        await p.getByRole('button', { name: 'ลบบัญชีถาวร' }).click();
        await p.getByText(/ยังมีใบสมัครที่ดำเนินอยู่/).waitFor();
        await check(
          'retry after blocked request',
          p.getByRole('button', { name: 'ลบบัญชีถาวร' }).isEnabled(),
        );
        await p.getByRole('button', { name: 'ลบบัญชีถาวร' }).click();
        await p.getByRole('heading', { name: 'ลบบัญชีเรียบร้อยแล้ว' }).waitFor();
        await p.waitForTimeout(350);
        await check(
          'receipt remains after signout',
          p.getByRole('heading', { name: 'ลบบัญชีเรียบร้อยแล้ว' }).isVisible(),
        );
      }),
      run(b, 'hr reviews', 'COMPANY_HR', async ({ p, go, check, at, calls }) => {
        const r1 = review(1),
          r2 = review(2);
        at('GET', '/companies/' + c1 + '/reviews', () => pageData([r1, r2]));
        at('POST', '/hr/reviews/' + r1.id + '/reply', (_u, r) => {
          return { body: r.postDataJSON().body, created_at: dt, review_id: r1.id };
        });
        await go('/hr/reviews');
        const form = p.locator('form:visible');
        await form.locator('textarea').fill('คำตอบที่หนึ่ง');
        await p.getByRole('button', { name: /รีวิว 2/ }).click();
        await check('review drafts separate', (await form.locator('textarea').inputValue()) === '');
        await p.getByRole('button', { name: /รีวิว 1/ }).click();
        await check(
          'first draft preserved',
          (await form.locator('textarea').inputValue()) === 'คำตอบที่หนึ่ง',
        );
        await form.getByRole('button', { name: 'ดูตัวอย่างคำตอบ' }).click();
        await check('preview does not publish', !calls.some((x) => x.path.endsWith('/reply')));
        await form.getByRole('button', { name: 'ยืนยันเผยแพร่คำตอบ' }).click();
        await p.getByText('คำตอบที่หนึ่ง', { exact: true }).waitFor();
        await check(
          'reply posted to selected review',
          calls.some(
            (call) => call.method === 'POST' && call.path === '/hr/reviews/' + r1.id + '/reply',
          ) && !r2.reply,
        );
      }),
      run(b, 'advisor', 'ADVISOR', async ({ p, go, check, at, calls }) => {
        at('GET', '/advisor/disputes', () => pageData([]));
        at('GET', '/advisor/applications', (u) =>
          u.searchParams.get('status') === 'ADVISOR_PENDING'
            ? pageData([{ ...app, status: 'ADVISOR_PENDING', frozen: true }])
            : pageData(
                [
                  {
                    ...app,
                    status: u.searchParams.get('status'),
                    flagged_for_advisor: u.searchParams.get('page') === '2',
                  },
                ],
                u.searchParams.get('status') === 'IN_PROGRESS' ? 2 : 1,
                Number(u.searchParams.get('page') || 1),
                1,
              ),
        );
        await go('/advisor/approvals');
        const approve = p.getByRole('button', { name: 'อนุมัติ', exact: true });
        await approve.waitFor();
        await check('frozen application prevents approval', approve.isDisabled());
        await check(
          'frozen application still allows rejection',
          p.getByRole('button', { name: 'ไม่อนุมัติ', exact: true }).isEnabled(),
        );
        await go('/advisor');
        await p.getByRole('heading', { name: 'การฝึกงานที่มีธงเตือน' }).waitFor();
        await check(
          'flag found on second API page',
          calls.some((q) => q.path === '/advisor/applications' && q.params.get('page') === '2'),
        );
        await p.getByRole('link', { name: /กรณีบริษัทไม่ประเมิน/ }).click();
        await p.getByRole('heading', { name: 'บันทึกผลทางวิชาการ' }).waitFor();
        await check(
          'card opens intended filter',
          (await p.getByLabel('สถานะใบสมัคร').inputValue()) === 'NO_EVALUATION',
        );
        await p.getByLabel('สถานะใบสมัคร').selectOption('EVALUATED_FAIL');
        await p
          .getByRole('button', { name: /บันทึกผลวิชา|บันทึกผลรายวิชา|บันทึกผลทางวิชาการ/ })
          .last()
          .click();
        await p.locator('input[type=radio]').first().waitFor();
        await check(
          'no preselected grade',
          (await p.locator('input[type=radio]:checked').count()) === 0,
        );
        await check(
          'no pass for failed assessment',
          (await p.locator('input[value=ACADEMIC_PASS]').count()) === 0,
        );
        await check(
          'submit disabled until a grade chosen',
          p.locator('form button[type=submit]').isDisabled(),
        );
      }),
      run(b, 'admin unlock', 'PLATFORM_ADMIN', async ({ p, go, check, at, calls }) => {
        const people = [
          { id: s1, student_code: 'S11', full_name: 'ชื่อซ้ำ', email: 'one@campus.test' },
          { id: s2, student_code: 'S11', full_name: 'ชื่อซ้ำ', email: 'two@campus.test' },
        ];
        at('GET', '/admin/users', () => pageData(people));
        at('POST', '/admin/lifecycle/students/' + s2 + '/reapply-unlock', () => ({
          id: a1,
          student_user_id: s2,
        }));
        await go('/admin/applications');
        await p.getByRole('button', { name: 'ปลดล็อกสมัครซ้ำ', exact: true }).click();
        await p.getByRole('textbox', { name: /ชื่อ อีเมล/ }).fill('S11');
        await p.getByRole('button', { name: 'ค้นหา', exact: true }).click();
        await p.getByRole('button', { name: /two@campus/ }).click();
        await p.getByLabel(/เหตุผลที่ปลดล็อก/).fill('แก้ไขตามคำร้อง');
        p.once('dialog', (d) => d.accept());
        await p.getByRole('button', { name: 'ปลดล็อก', exact: true }).click();
        await p.getByText(/ปลดล็อกแล้ว นักศึกษา/).waitFor();
        await check(
          'selecting by email sends correct student id',
          calls
            .filter((x) => x.method === 'POST' && x.path.includes('reapply-unlock'))
            .every((x) => x.path.includes(s2)),
        );
      }),
      run(b, 'admin tags', 'PLATFORM_ADMIN', async ({ p, go, check, at }) => {
        const tag = { id: a1, name: 'Frontend', slug: 'frontend', active: true, job_count: 7 };
        let written;
        at('GET', '/admin/tags', () => pageData([tag]));
        at('PATCH', '/admin/tags/' + a1, (_u, r) => {
          written = r.postDataJSON();
          Object.assign(tag, written);
          return tag;
        });
        await go('/admin/tags');
        await p.getByRole('button', { name: 'จัดการ Tag Frontend' }).click();
        const d = p.getByRole('dialog');
        await d.getByRole('textbox').fill('Frontend 2');
        await d.getByRole('checkbox').uncheck();
        await d.getByRole('button', { name: 'บันทึก' }).click();
        await p.getByRole('button', { name: 'จัดการ Tag Frontend 2' }).waitFor();
        await check(
          'rename and retire only change name and active',
          written.name === 'Frontend 2' &&
            written.active === false &&
            Object.keys(written).length === 2,
        );
        await check(
          'slug unchanged',
          p.getByRole('cell', { name: 'Frontend 2 frontend', exact: true }).isVisible(),
        );
      }),
    ]);
    await Promise.all([
      run(b, 'student certificate feedback', 'STUDENT', async ({ p, at, go, check }) => {
        const first = {
          id: a1,
          certificate_code: 'IP-2026-A8C9E4QT',
          company_name: 'บริษัท ก',
          job_title: 'ฝึกงานวิศวกรรม',
          period: { start: '2026-08-01', end: '2026-11-01' },
          actual_days: 90,
          status: 'VALID',
          issued_at: dt,
        };
        const second = {
          ...first,
          id: s2,
          certificate_code: 'IP-2026-K8Q9A2TM',
          job_title: 'ฝึกงานออกแบบ',
          status: 'REVOKED',
        };
        await p.addInitScript(() =>
          Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: async () => {} },
            configurable: true,
          }),
        );
        at('GET', '/me/certificates', () => pageData([first, second]));
        let finishDownload;
        const hold = new Promise((resolve) => {
          finishDownload = resolve;
        });
        at('GET', '/me/certificates/' + a1 + '/download', async () => {
          await hold;
          first.status = 'REVOKED';
          return { statusCode: 409, details: [{ issue: 'CERTIFICATE_REVOKED' }] };
        });
        await go('/student/certificates');
        const original = p.getByRole('listitem').filter({ hasText: first.certificate_code });
        const other = p.getByRole('listitem').filter({ hasText: second.certificate_code });
        try {
          await original.getByRole('button', { name: 'ดาวน์โหลด PDF' }).click();
          await other.getByRole('button', { name: 'คัดลอกลิงก์ตรวจสอบ' }).click();
          await other.getByText('คัดลอกลิงก์ตรวจสอบแล้ว').waitFor();
        } finally {
          finishDownload();
        }
        await original.getByRole('alert').waitFor();
        await check(
          'download failure stays on correct certificate',
          !(await other.getByRole('alert').count()),
        );
        await check(
          'copy feedback remains on other certificate',
          other.getByText('คัดลอกลิงก์ตรวจสอบแล้ว').isVisible(),
        );
        await check(
          'review link is independent of certificate validity',
          p.getByRole('link', { name: 'เขียนรีวิวบริษัท' }).isVisible(),
        );
      }),
      run(b, 'email verification', null, async ({ p, go, at, check }) => {
        let result = { statusCode: 503, code: 'SERVICE_UNAVAILABLE' };
        at('POST', '/auth/verify-email', () => result);
        await go('/verify-email?token=fixture');
        const submit = p.getByRole('button', { name: 'ยืนยันอีเมล', exact: true });
        await submit.click();
        await p.getByRole('main').getByRole('alert').waitFor();
        await check(
          'temporary error receives focus',
          p
            .getByRole('main')
            .getByRole('alert')
            .evaluate((el) => el === document.activeElement),
        );
        result = { statusCode: 409, code: 'STATE_CONFLICT' };
        await submit.click();
        await p.getByText(/สถานะบัญชีเปลี่ยนแล้ว ลองเข้าสู่ระบบ/).waitFor();
        await check(
          'changed account offers login',
          (await p
            .getByRole('main')
            .getByRole('link', { name: 'เข้าสู่ระบบ' })
            .getAttribute('href')) === '/login',
        );
        await check('used link cannot be submitted again', !(await submit.isVisible()));
        result = { statusCode: 204 };
        await go('/verify-email?token=fresh');
        await submit.click();
        const done = p.getByRole('heading', { name: 'ยืนยันอีเมลแล้ว' });
        await done.waitFor();
        await check(
          'success heading receives focus',
          done.evaluate((el) => el === document.activeElement),
        );
      }),
      run(b, 'HR tag recovery', 'COMPANY_HR', async ({ p, go, at, check }) => {
        let failed = true;
        at('GET', '/tags', () =>
          failed ? { statusCode: 503 } : pageData([{ id: a1, name: 'Backend', slug: 'backend' }]),
        );
        await go('/hr/jobs/form');
        const retry = p.getByRole('button', { name: 'ลองโหลด Tag อีกครั้ง' });
        await retry.waitFor();
        const title = p.getByRole('textbox', { name: 'ชื่อตำแหน่ง' });
        await title.fill('วิศวกรโครงการ');
        failed = false;
        await retry.click();
        await p.getByRole('checkbox', { name: 'Backend' }).waitFor();
        await check(
          'typed job title retained on retry',
          (await title.inputValue()) === 'วิศวกรโครงการ',
        );
        await check(
          'tag can be selected after recovery',
          p.getByRole('checkbox', { name: 'Backend' }).isEnabled(),
        );
      }),
      run(b, 'admin report identity', 'PLATFORM_ADMIN', async ({ p, at, go, check, calls }) => {
        const report = {
          id: a1,
          application_id: app.id,
          student_user_id: s2,
          category: 'OTHER',
          detail: 'ขอคำปรึกษา',
          status: 'OPEN',
          overdue: false,
          due_at: dt,
          created_at: dt,
        };
        at('GET', '/admin/lifecycle/problem-reports', () => pageData([report]));
        at('GET', '/admin/users', (url) => {
          const page = Number(url.searchParams.get('page'));
          return pageData(
            [{ id: page === 1 ? s1 : s2, full_name: 'ชื่อซ้ำ', student_code: 'S0' + page }],
            2,
            page,
            1,
          );
        });
        await go('/admin/problem-reports');
        const lookup = p.getByRole('button', { name: 'ดูข้อมูลนักศึกษา' });
        await lookup.waitFor();
        await check(
          'directory is only queried on demand',
          !calls.some((call) => call.path === '/admin/users'),
        );
        await lookup.click();
        await p.getByText('นักศึกษา · ชื่อซ้ำ · S02').waitFor();
        await check(
          'resolved student from second page without mixing names',
          !(await p.getByText(/S01/).count()),
        );
        await check(
          'audit link identifies selected application',
          (await p.getByRole('link', { name: 'ประวัติใน Audit log' }).getAttribute('href')).endsWith(
            app.id,
          ),
        );
      }),
      run(b, 'advisor concurrent resolution', 'ADVISOR', async ({ p, at, go, check }) => {
        let closed = false;
        const report = {
          id: a1,
          application_id: app.id,
          student_user_id: s1,
          category: 'OTHER',
          detail: 'ขอคำปรึกษา',
          status: 'OPEN',
          overdue: true,
          due_at: dt,
          created_at: dt,
        };
        at('GET', '/advisor/problem-reports', (url) => {
          if (url.searchParams.get('status') !== 'RESOLVED')
            return pageData(closed ? [] : [report]);
          const page = Number(url.searchParams.get('page'));
          return pageData(
            [
              {
                ...report,
                status: 'RESOLVED',
                overdue: false,
                id: page === 1 ? s2 : a1,
                resolution_note: page === 1 ? 'อีกกรณี' : 'ผู้ดูแลได้ติดตามแล้ว',
              },
            ],
            2,
            page,
            1,
          );
        });
        at('GET', '/advisor/students/' + s1 + '/overview', () => ({
          student_user_id: s1,
          full_name: 'ผู้แจ้ง',
          applications: [app],
        }));
        at('POST', '/problem-reports/' + a1 + '/actions/resolve', () => {
          closed = true;
          return {
            statusCode: 409,
            code: 'STATE_CONFLICT',
            details: [{ issue: 'ALREADY_RESOLVED' }],
          };
        });
        await go('/advisor/problem-reports');
        await p.getByRole('button', { name: 'ปิดเรื่อง', exact: true }).click();
        await p.getByLabel('สรุปผลการดำเนินการ').fill('ข้อสรุปที่กำลังส่ง');
        await p.getByRole('button', { name: 'ยืนยันปิดเรื่อง' }).click();
        await p.getByText(/ผลการดำเนินการ.*ผู้ดูแลได้ติดตามแล้ว/).waitFor();
        await check(
          'resolved report no longer editable',
          !(await p.getByRole('button', { name: 'ยืนยันปิดเรื่อง' }).count()),
        );
        await check(
          'shows the selected report instead of a different resolved case',
          !(await p.getByText(/อีกกรณี/).count()),
        );
      }),
    ]);
  } finally {
    await b.close();
    console.log('checks', all.length, 'failures', failures.length);
  }
  if (failures.length) process.exitCode = 1;
})().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
