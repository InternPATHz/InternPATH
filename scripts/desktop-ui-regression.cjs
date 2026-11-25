// Start the web app, then run: WEB_BASE_URL=http://localhost:3100 node scripts/desktop-ui-regression.cjs
// Uses the Playwright dependency already declared by the Lifecycle workspace.
const { createRequire } = require('node:module');
const { resolve } = require('node:path');
const { chromium } = createRequire(resolve(__dirname, '../apps/lifecycle/package.json'))('playwright');
const assert = require('node:assert/strict');
const root = process.env.WEB_BASE_URL ?? 'http://localhost:3100';
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
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 820 } }),
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
      if (path === '/auth/refresh') value = { access_token: 'fixture', refresh_token: 'fixture', user: me };
      else if (path === '/users/me') value = me;
      else if (path === '/notifications/unread-count') value = { unread_count: 0 };
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
      '1024px fits',
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
            ? { statusCode: 409, code: 'DELETION_BLOCKED', details: [{ issue: 'ACTIVE_APPLICATION' }] }
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
          r1.reply = { body: r.postDataJSON().body, created_at: dt };
          return { ...r1.reply, review_id: r1.id };
        });
        await go('/hr/reviews');
        const form = p.locator('form:visible');
        await form.locator('textarea').fill('คำตอบที่หนึ่ง');
        await p.getByRole('button', { name: /รีวิว 2/ }).click();
        await check('review drafts separate', (await form.locator('textarea').inputValue()) === '');
        await p.getByRole('button', { name: /รีวิว 1/ }).click();
        await check('first draft preserved', (await form.locator('textarea').inputValue()) === 'คำตอบที่หนึ่ง');
        await form.getByRole('button', { name: 'ดูตัวอย่างคำตอบ' }).click();
        await check('preview does not publish', !calls.some((x) => x.path.endsWith('/reply')));
        await form.getByRole('button', { name: 'ยืนยันเผยแพร่คำตอบ' }).click();
        await p.getByText('คำตอบที่หนึ่ง', { exact: true }).waitFor();
        await check('reply posted to selected review', r1.reply.body === 'คำตอบที่หนึ่ง' && !r2.reply);
      }),
      run(b, 'advisor', 'ADVISOR', async ({ p, go, check, at, calls }) => {
        at('GET', '/advisor/applications', (u) =>
          u.searchParams.get('status') === 'IN_PROGRESS'
            ? pageData(
                [{ ...app, flagged_for_advisor: u.searchParams.get('page') === '2' }],
                2,
                Number(u.searchParams.get('page')),
                1,
              )
            : pageData([{ ...app, status: u.searchParams.get('status') }]),
        );
        at('GET', '/advisor/disputes', () => pageData([]));
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
        await check('no preselected grade', (await p.locator('input[type=radio]:checked').count()) === 0);
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
          written.name === 'Frontend 2' && written.active === false && Object.keys(written).length === 2,
        );
        await check('slug unchanged', p.getByRole('cell', { name: 'frontend', exact: true }).isVisible());
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
