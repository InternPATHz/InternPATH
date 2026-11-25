import { randomUUID } from 'node:crypto';
import { check, cli, poll } from './runtime.mjs';
import { adminEmail, bangkokDate, date, day, demoLogo, major, requestedPacks, scenario, syntheticPdf, tagNames, upload } from './scenarios.mjs';

const one = (rows, key) => {
  check(rows.length < 2, `Multiple records match ${key}. Inspect the local data before resuming.`);
  return rows[0];
};
const selectOne = async (model, where, key) => one(await model.findMany({ where, take: 2 }), key);

function tools(ctx) {
  const { manifest, save } = ctx;
  async function own(key, find, create, match = () => true, idOf = row => row.id) {
    const entry = manifest.entries[key];
    let row = await find(entry?.id);
    if (entry?.id) {
      check(row && idOf(row) === entry.id && match(row), `Owned record ${key} is missing or its ownership changed.`);
      return row;
    }
    if (!entry) {
      check(!row, `Unowned record conflicts with ${key}.`);
      manifest.entries[key] = { startedAt: new Date().toISOString() };
      save();
    }
    if (!row) {
      await create();
      row = await find();
    }
    check(row && match(row), `Could not establish ownership of ${key}. Inspect the manifest and local data.`);
    if (entry && row.createdAt && row.id !== entry.fixtureId) {
      check(row.createdAt >= new Date(entry.startedAt), `Record ${key} predates the seed intent.`);
    }
    manifest.entries[key].id = idOf(row);
    save();
    return row;
  }
  async function step(key, action) {
    if (manifest.entries[key]?.done) return;
    await action();
    manifest.entries[key] = { done: true };
    save();
  }
  const post = (path, token, body, expect = [200, 201, 204]) =>
    ctx.api(path, { method: 'POST', body, token, expect });
  return { ...ctx, own, step, post };
}

async function namespacePreflight(d, plans) {
  const { identity: id, job } = d.db;
  const emails = [[adminEmail, 'admin']];
  const companies = [];
  for (const plan of plans) {
    const key = plan.name;
    emails.push([plan.advisor, `${key}/advisor`], [plan.company.email, `${key}/company/owner`]);
    companies.push([plan.company.registration, `${key}/company`]);
    if (plan.member) emails.push([plan.member, `${key}/member`]);
    if (plan.approval) {
      emails.push([plan.approval.email, `${key}/approval/owner`]);
      companies.push([plan.approval.registration, `${key}/approval`]);
    }
    for (const [kind, info] of Object.entries(plan.students)) emails.push([info.email, `${key}/student/${kind}`]);
  }
  const available = (row, key) => {
    const entry = d.manifest.entries[key];
    check(!row || (entry?.id ? entry.id === row.id : entry?.startedAt && row.createdAt >= new Date(entry.startedAt)),
      `Unowned record conflicts with ${key}. The seed did not claim it.`);
  };
  for (const [email, key] of emails) available(await id.user.findUnique({ where: { email } }), key);
  for (const [registrationNo, key] of companies) available(await id.company.findUnique({ where: { registrationNo } }), key);
  for (const name of tagNames) {
    const slug = name.toLowerCase().replace(/[^a-z0-9 -]/gu, '').replace(/ +/gu, '-');
    available(await job.tag.findUnique({ where: { slug } }), `tag/${slug}`);
  }
}

async function verifyEmail(d, user) {
  if (user.emailVerifiedAt) return;
  const token = await d.mailToken(user.email, '/verify-email');
  await d.identity('/auth/verify-email', { method: 'POST', body: { token }, expect: [204] });
}

async function advisor(d, plan, admin) {
  const { identity } = d.db;
  const row = await d.own(`${plan.name}/advisor`, id => identity.user.findUnique({ where: id ? { id } : { email: plan.advisor } }),
    () => d.identity('/auth/register/advisor', { method: 'POST', expect: [201],
      body: { email: plan.advisor, password: d.env.DEMO_PASSWORD, full_name: `อาจารย์ อรุณ (${plan.label})`, department: major, accept_privacy: true } }),
    user => user.role === 'ADVISOR' && user.email === plan.advisor);
  await verifyEmail(d, row);
  const active = await identity.user.findUniqueOrThrow({ where: { id: row.id } });
  if (active.status === 'PENDING_APPROVAL') await d.post(`/admin/advisors/${row.id}/actions/approve`, admin, {});
  return { id: row.id, token: await d.login(row.email, 'ADVISOR', row.id) };
}

async function company(d, key, spec, admin, verified) {
  const { identity: id, job, lifecycle, verification } = d.db;
  const findOwner = userId => id.user.findUnique({ where: userId ? { id: userId } : { email: spec.email } });
  const owner = await d.own(`${key}/owner`, findOwner, async () => {
    check(!await id.company.count({ where: { registrationNo: spec.registration } }), `Unowned company conflicts with ${key}.`);
    // Store the company intent before the Identity transaction creates both records.
    if (!d.manifest.entries[key]) {
      d.manifest.entries[key] = { startedAt: new Date().toISOString() };
      d.save();
    }
    await d.identity('/auth/register/company', { method: 'POST', expect: [201],
      body: { company: { name: spec.title, registration_no: spec.registration, phone: '020000000' },
        user: { email: spec.email, password: d.env.DEMO_PASSWORD, full_name: `ทีม HR ${spec.title}` }, accept_privacy: true } });
  }, user => user.role === 'COMPANY_HR' && user.email === spec.email);
  const org = await d.own(key, idValue => id.company.findUnique({
    where: idValue ? { id: idValue } : { registrationNo: spec.registration }, include: { members: true },
  }), () => check(false, `Company missing for ${key}.`),
  row => row.emailDomain === spec.domain && row.registrationNo === spec.registration && row.members.some(m => m.userId === owner.id && m.memberRole === 'OWNER'));
  await verifyEmail(d, owner);
  const token = await d.login(owner.email, 'COMPANY_HR', owner.id);
  const docsKey = `${key}/document`;
  await d.own(docsKey, idValue => selectOne(id.companyDocument,
    { companyId: org.id, uploadedBy: owner.id, docType: 'REGISTRATION_CERT', ...(idValue ? { id: idValue } : {}) }, docsKey),
  () => d.post('/companies/me/documents', token, upload(syntheticPdf('Fictional Company Registration'), 'registration.pdf', 'application/pdf', { doc_type: 'REGISTRATION_CERT' })),
  row => row.mime === 'application/pdf');
  await d.step(`${key}/logo`, async () => {
    const row = await id.company.findUniqueOrThrow({ where: { id: org.id } });
    if (!row.logoKey) await d.post('/companies/me/logo', token, upload(demoLogo, 'demo-logo.png', 'image/png'));
  });
  if (verified) await d.step(`${key}/verify`, async () => {
    const row = await id.company.findUniqueOrThrow({ where: { id: org.id } });
    if (row.status === 'PENDING') await d.post(`/admin/companies/${org.id}/actions/verify`, admin, {});
    else check(row.status === 'VERIFIED', `Company ${key} cannot be verified from its current status.`);
  });
  const status = (await id.company.findUniqueOrThrow({ where: { id: org.id } })).status;
  await poll(`${key} company projections`, async () => (await Promise.all(
    [job, lifecycle, verification].map(db => db.companySnapshot.findUnique({ where: { companyId: org.id } })),
  )).every(row => row?.status === status));
  return { id: org.id, ownerId: owner.id, token };
}

async function member(d, plan, org) {
  const { identity: id } = d.db;
  return d.own(`${plan.name}/member`, userId => id.user.findUnique({
    where: userId ? { id: userId } : { email: plan.member }, include: { companyMember: true },
  }), async () => {
    const pending = await id.companyInvitation.findFirst({ where: { companyId: org.id, email: plan.member, acceptedAt: null, expiresAt: { gt: new Date() } } });
    if (!pending) await d.post('/companies/me/invitations', org.token, { email: plan.member, categories: ['TECH_IT'] });
    const token = await d.mailToken(plan.member, '/auth/invitations/accept');
    await d.identity('/auth/invitations/accept', { method: 'POST', expect: [201],
      body: { token, password: d.env.DEMO_PASSWORD, full_name: 'Demo HR Member' } });
  }, row => row.role === 'COMPANY_HR' && row.email === plan.member && row.companyMember?.companyId === org.id && row.companyMember.memberRole === 'MEMBER');
}

async function student(d, key, info, advisor, companyId) {
  const { identity: id, lifecycle } = d.db;
  const row = await d.own(key, userId => id.user.findUnique({
    where: userId ? { id: userId } : { email: info.email }, include: { studentProfile: true },
  }), () => d.post('/advisor-links/students', advisor.token, { email: info.email, full_name: info.name,
    student_code: info.code, major, year_level: 3 }),
  user => user.role === 'STUDENT' && user.email === info.email && user.studentProfile?.advisorId === advisor.id && user.studentProfile.studentCode === info.code);
  if (!row.emailVerifiedAt) {
    const token = await d.mailToken(row.email, '/student-invitation');
    await d.identity('/auth/student-invitations/accept', { method: 'POST', body: { token, password: d.env.DEMO_PASSWORD, accept_privacy: true }, expect: [204] });
  }
  await poll(`${key} advisor link`, async () => {
    const link = await lifecycle.studentAdvisorLink.findUnique({ where: { studentUserId: row.id } });
    return link?.linkStatus === 'LINKED' && link.advisorUserId === advisor.id;
  });
  const token = await d.login(row.email, 'STUDENT', row.id);
  const resumeKey = `${key}/resume`;
  const resume = await d.own(resumeKey, idValue => selectOne(lifecycle.resume,
    { studentUserId: row.id, deletedAt: null, ...(idValue ? { id: idValue } : {}) }, resumeKey),
  () => d.post('/me/resumes', token, upload(syntheticPdf('Synthetic InternPATH Resume'), 'resume.pdf', 'application/pdf')));
  const consentKey = `${key}/consent`;
  const consent = await d.own(consentKey, idValue => {
    const where = { userId: row.id, type: 'RESUME_SHARE', targetCompanyId: companyId, ...(idValue ? { id: idValue } : {}) };
    return id.consent.findFirst({ where, orderBy: { createdAt: 'desc' } });
  }, () => d.post('/users/me/consents', token, { type: 'RESUME_SHARE', target_company_id: companyId }));
  return { id: row.id, email: row.email, token, resumeId: resume.id, consentId: consent.id };
}

async function jobFixture(d, plan, spec, org, anchor, tagIds) {
  const { job, lifecycle, verification } = d.db;
  const key = `${plan.name}/job/${spec.key}`;
  const title = `[Demo ${plan.label}] ${spec.title}`;
  const row = await d.own(key, idValue => selectOne(job.job, {
    companyId: org.id, createdBy: org.ownerId, ...(idValue ? { id: idValue } : { jobTitle: title }),
  }, key), () => d.post('/hr/jobs', org.token, {
    category: spec.category, job_title: title, tag_ids: tagIds,
    description: 'ฝึกงานกับบริษัทสมมติในชุดสาธิต InternPATH',
    responsibilities: `ร่วมทำโครงการ ${spec.title} และสรุปผลกับพี่เลี้ยง`,
    qualifications: 'สนใจเรียนรู้และสื่อสารกับทีม', allowance: { type: 'AMOUNT', amount_thb: 6000 },
    location: 'กรุงเทพมหานคร', work_mode: 'HYBRID', hours_per_week: 35, target_majors: [major], quota: 8,
    period: { start: day(anchor, -70), end: day(anchor, 150) }, application_deadline: day(anchor, 90),
  }));
  if (spec.status === 'DRAFT') return row.id;
  const read = () => job.job.findUniqueOrThrow({ where: { id: row.id } });
  await d.step(`${key}/submit`, async () => {
    const current = await read();
    if (current.status === 'DRAFT') await d.post(`/hr/jobs/${row.id}/actions/submit`, org.token);
    else check(['PUBLISHED', 'VERIFYING', 'PENDING_REVIEW', 'CLOSED'].includes(current.status), `Unexpected status for ${key}.`);
  });
  if (spec.status === 'CLOSED') await d.step(`${key}/close`, async () => {
    if ((await read()).status === 'PUBLISHED') await d.post(`/hr/jobs/${row.id}/actions/close`, org.token);
  });
  const allowed = spec.status === 'VERIFYING' ? ['VERIFYING', 'PENDING_REVIEW'] : [spec.status];
  await poll(`${key} status and snapshots`, async () => {
    const statuses = await Promise.all([read(), lifecycle.jobSnapshot.findUnique({ where: { jobId: row.id } }),
      verification.jobSnapshot.findUnique({ where: { jobId: row.id } })]);
    return statuses.every(item => item && allowed.includes(item.status));
  });
  return row.id;
}

const historicalStates = ['PENDING', 'HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS'];

async function historical(d, plan, kind, anchor, student, advisor, company, jobId) {
  const { lifecycle: db, job, identity } = d.db;
  const key = `${plan.name}/application/${kind}`;
  const marker = `Synthetic InternPATH ${key}`;
  const [startOffset, endOffset] = { certificate: [-45, -5], problem: [-12, 40], overdue: [-62, -17] }[kind];
  const start = day(anchor, startOffset);
  const end = day(anchor, endOffset);
  const stages = [
    [day(start, -6), student.id, 'STUDENT'], [day(start, -5), company.ownerId, 'COMPANY_HR'],
    [day(start, -4), student.id, 'STUDENT'], [day(start, -2), advisor.id, 'ADVISOR'],
    [start, company.ownerId, 'COMPANY_HR'],
  ];
  const row = await d.own(key, id => selectOne(db.application, {
    studentUserId: student.id, jobId, ...(id ? { id } : {}),
  }, key), async () => {
    const [resume, consent, snapshot, linked] = await Promise.all([
      db.resume.findUnique({ where: { id: student.resumeId } }),
      identity.consent.findUnique({ where: { id: student.consentId } }),
      db.jobSnapshot.findUnique({ where: { jobId } }),
      db.studentAdvisorLink.findUnique({ where: { studentUserId: student.id } }),
    ]);
    check(resume?.studentUserId === student.id && !resume.deletedAt &&
      consent?.userId === student.id && consent.type === 'RESUME_SHARE' && consent.targetCompanyId === company.id && !consent.revokedAt &&
      snapshot?.companyId === company.id && snapshot.status === 'PUBLISHED' && snapshot.title &&
      linked?.advisorUserId === advisor.id && linked.linkStatus === 'LINKED',
    `Cannot create ${key}: owned resume, consent, published job or advisor link is missing.`);
    // The approved historical write is restricted to two tables in Lifecycle.
    // Insert the entire timeline once. Existing audit triggers remain enabled.
    const intent = d.manifest.entries[key];
    if (!intent.fixtureId) {
      intent.fixtureId = randomUUID();
      d.save();
    }
    const id = intent.fixtureId;
    const correlationId = randomUUID();
    await db.$transaction(async tx => {
      await tx.application.create({ data: {
        id, jobId, companyId: company.id, studentUserId: student.id, advisorUserId: advisor.id,
        resumeId: student.resumeId, resumeConsentId: student.consentId, coverLetter: marker,
        status: 'IN_PROGRESS', startDate: new Date(start), endDate: new Date(end), actualStartDate: new Date(start),
        createdAt: date(stages[0][0]), statusChangedAt: date(start), version: stages.length, entityVersion: stages.length,
        quotaReserved: true,
      } });
      await tx.statusHistory.createMany({ data: stages.map(([occurred, actorId, actorRole], index) => ({
        entity: 'APPLICATION', entityId: id, fromStatus: historicalStates[index - 1] ?? null,
        toStatus: historicalStates[index], actorId, actorRole, correlationId, occurredAt: date(occurred),
      })) });
    });
  }, app => app.coverLetter === marker && app.companyId === company.id && app.advisorUserId === advisor.id &&
    app.resumeId === student.resumeId && app.resumeConsentId === student.consentId);
  // The fixture is visible to Lifecycle's reconciliation now. Use the documented
  // idempotent Job service API to establish its confirmed reservation.
  await d.step(`${key}/quota`, async () => {
    const lease = await job.quotaReservation.findUnique({ where: { applicationId: row.id } });
    check(!lease || lease.jobId === jobId, `Quota reservation belongs to another job for ${key}.`);
    if (lease?.status !== 'CONFIRMED') {
      await d.quota(jobId, row.id, 'reserve');
      await d.quota(jobId, row.id, 'confirm');
    }
    check((await job.quotaReservation.findUniqueOrThrow({ where: { applicationId: row.id } })).status === 'CONFIRMED',
      `Quota was not confirmed for ${key}.`);
  });
  return row.id;
}

async function displayActions(d, plan, students, applications, org, advisor, offer) {
  const { lifecycle: lc, identity, verification } = d.db;
  const app = applications.certificate;
  const student = students.certificate;
  const hr = path => `/hr/applications/${app}${path}`;
  await d.step('display/evaluation', async () => {
    const present = await lc.evaluation.findUnique({ where: { applicationId_round: { applicationId: app, round: 1 } } });
    if (!present) await d.post(hr('/actions/evaluate'), org.token, { result: 'PASS', note: 'ผลประเมินสำหรับชุดสาธิต' });
    else check(present.result === 'PASS' && present.evaluatedBy === org.ownerId, 'Unexpected demo evaluation.');
  });
  const cert = await d.own('display/certificate', id => lc.certificate.findUnique({ where: id ? { id } : { applicationId: app } }),
    () => d.post(hr('/certificate'), org.token), row => row.applicationId === app && row.studentUserId === student.id && row.issuedBy === org.ownerId);
  const review = await d.own('display/review', id => lc.review.findUnique({ where: id ? { id } : { applicationId: app } }),
    () => d.post(`/applications/${app}/review`, student.token, { rating: 5, title: 'พี่เลี้ยงดูแลดีมาก',
      body: 'ได้ฝึกทำงานกับทีมและได้รับคำแนะนำทุกสัปดาห์ ข้อความนี้เป็นข้อมูลสาธิต', anonymous: true }),
    row => row.applicationId === app && row.studentUserId === student.id && row.rating === 5);
  await poll('display review publication and Identity rating', async () => {
    const [published, stats] = await Promise.all([
      lc.review.findUnique({ where: { id: review.id } }), identity.companyRatingStats.findUnique({ where: { companyId: org.id } }),
    ]);
    return published?.status === 'PUBLISHED' && stats?.reviewCount === 1 && stats.ratingSum === 5;
  });
  const reviewReport = await d.own('display/review-report', id => selectOne(verification.reviewReport, {
    reviewId: review.id, reporterUserId: org.ownerId, ...(id ? { id } : {}),
  }, 'display review report'), () => d.post(`/reviews/${review.id}/reports`, org.token,
    { reason: 'ข้อมูลสาธิตสำหรับแสดงคิวตรวจรีวิวของ Admin' }));
  await d.step('display/academic-result', async () => {
    const current = await lc.application.findUniqueOrThrow({ where: { id: app } });
    if (!current.academicResult) await d.post(`/advisor/applications/${app}/academic-result`, advisor.token, { academic_result: 'ACADEMIC_PASS' });
    else check(current.academicResult === 'ACADEMIC_PASS', 'Unexpected demo academic result.');
  });
  const detail = 'ขอคำแนะนำเรื่องตารางทำงานและชั่วโมงฝึกงานในชุดสาธิต';
  const problem = await d.own('display/problem-report', id => selectOne(lc.problemReport, {
    applicationId: applications.problem, studentUserId: students.problem.id, detail, ...(id ? { id } : {}),
  }, 'display problem report'), () => d.post(`/applications/${applications.problem}/problem-reports`, students.problem.token,
    { category: 'WORKLOAD_OR_HOURS', detail }));
  await d.step('display/offer', async () => {
    const row = await lc.application.findUniqueOrThrow({ where: { id: offer.id } });
    if (row.status === 'PENDING') await d.post(`/hr/applications/${offer.id}/actions/accept`, org.token,
      { start_date: day(d.manifest.packs[plan.name].anchor, 7), end_date: day(d.manifest.packs[plan.name].anchor, 47) });
    else check(row.status === 'HR_ACCEPTED', 'Unexpected display offer status.');
  });
  return { certificateId: cert.id, certificateCode: cert.certificateCode, reviewId: review.id,
    reviewReportId: reviewReport.id, problemId: problem.id, offerId: offer.id };
}

async function seedPack(d, plan, admin, tagIds) {
  const { job, identity, verification, notification, lifecycle } = d.db;
  const existing = d.manifest.packs[plan.name];
  if (existing?.complete) {
    console.log(`Pack ${plan.label}: preserved. Run demo:verify for current readiness.`);
    return;
  }
  const pack = existing ?? { anchor: bangkokDate(), complete: false };
  d.manifest.packs[plan.name] = pack;
  d.save();
  const org = await company(d, `${plan.name}/company`, plan.company, admin, true);
  const approval = plan.approval ? await company(d, `${plan.name}/approval`, plan.approval, admin, false) : null;
  const teacher = await advisor(d, plan, admin);
  const hrMember = plan.member ? await member(d, plan, org) : null;
  const people = {};
  for (const [kind, spec] of Object.entries(plan.students)) {
    people[kind] = await student(d, `${plan.name}/student/${kind}`, spec, teacher, org.id);
  }
  const jobs = {};
  for (const spec of plan.jobs) {
    if (spec.status === 'VERIFYING') {
      await d.step('display/flag', () => d.api(`/admin/flags/companies/${org.id}/under-review`,
        { method: 'PUT', token: admin, body: { active: true, reason: 'ชุดสาธิตคิวตรวจประกาศ' } }));
      await poll('display company flag in Job', async () => (await job.companyFlag.findUnique({ where: { companyId: org.id } }))?.underReview === true);
    }
    jobs[spec.key] = await jobFixture(d, plan, spec, org, pack.anchor, tagIds);
  }
  // E03 carries status, not the title. A normal synthetic application fills the
  // Lifecycle job title through its existing Job API before real certificate issuance.
  const jobId = jobs['published-1'];
  const offerKey = `${plan.name}/application/offer`;
  const offer = await d.own(offerKey, id => selectOne(lifecycle.application, {
    studentUserId: people.offer.id, jobId, ...(id ? { id } : {}),
  }, offerKey), () => d.post('/applications', people.offer.token,
    { job_id: jobId, resume_id: people.offer.resumeId, consent: true, cover_letter: 'ข้อมูลใบสมัครสาธิต' }));
  check((await lifecycle.jobSnapshot.findUniqueOrThrow({ where: { jobId } })).title,
    `Normal application did not initialize the Lifecycle title for ${offerKey}.`);
  const historicalKinds = plan.display ? ['certificate', 'problem', 'overdue'] : ['certificate', 'problem'];
  const applications = {};
  for (const kind of historicalKinds) {
    applications[kind] = await historical(d, plan, kind, pack.anchor, people[kind], teacher, org, jobs['published-1']);
  }
  const artifacts = plan.display ? await displayActions(d, plan, people, applications, org, teacher, offer) : { offerId: offer.id };
  if (plan.display) {
    await poll('display Verification queues', async () => (await Promise.all([
      verification.queueItem.count({ where: { type: 'JOB_REVIEW', targetId: jobs.review, status: 'OPEN' } }),
      verification.queueItem.count({ where: { type: 'REVIEW_REPORT', targetId: artifacts.reviewId, status: 'OPEN' } }),
    ])).every(n => n === 1));
    const audit = await identity.adminAuditLog.count({ where: { targetId: org.id } });
    check(audit > 0, 'Display company approval has no audit row.');
    await poll('display certificate, review and problem notifications', async () => {
      const events = [
        ['CertificateIssued', artifacts.certificateId, people.certificate.id],
        ['ReviewPublished', org.id, org.ownerId],
        ['ProblemReportCreated', artifacts.problemId, teacher.id],
      ];
      const delivered = await Promise.all(events.map(async ([type, aggregateId, userId]) => {
        const rows = await lifecycle.outboxEvent.findMany({ where: { type, aggregateId }, select: { id: true } });
        return rows.length && await notification.notification.count({ where: { sourceEventId: { in: rows.map(row => row.id) }, userId } });
      }));
      return delivered.every(Boolean);
    });
  }
  const counts = { accounts: 2 + Object.keys(people).length + Number(Boolean(approval)) + Number(Boolean(hrMember)),
    jobs: Object.keys(jobs).length, historical: Object.keys(applications).length };
  Object.assign(pack, { complete: true, counts, companyId: org.id, ownerId: org.ownerId,
    approvalId: approval?.id, approvalOwnerId: approval?.ownerId, advisorId: teacher.id, memberId: hrMember?.id,
    students: Object.fromEntries(Object.entries(people).map(([kind, row]) => [kind, { id: row.id, resumeId: row.resumeId, consentId: row.consentId }])),
    jobs, applications, artifacts, finishedAt: new Date().toISOString() });
  d.save();
  console.log(`Pack ${plan.label}: ${counts.accounts} accounts, ${counts.jobs} jobs, ${counts.historical} historical applications.`);
}

await cli('seed', async ctx => {
  const d = tools(ctx);
  const plans = ['display', ...requestedPacks(process.argv.slice(2))].map(scenario);
  await namespacePreflight(d, plans);
  if (plans.every(plan => d.manifest.packs[plan.name]?.complete)) {
    console.log('All requested fixtures already exist. Preserved all scenario state. Run demo:verify for readiness.');
    return;
  }
  const { identity, job } = d.db;
  const admin = await d.own('admin', id => identity.user.findUnique({ where: id ? { id } : { email: adminEmail } }),
    () => d.seedAdmin(adminEmail), row => row.email === adminEmail && row.role === 'PLATFORM_ADMIN' && row.status === 'ACTIVE');
  const token = await d.login(admin.email, 'PLATFORM_ADMIN', admin.id);
  // Gateway /ready can succeed before its first Identity denylist refresh.
  await poll('authenticated Gateway readiness', async () => {
    try { return await d.api('/admin/tags?page_size=1', { token }); }
    catch (error) { if (error.status !== 503) throw error; }
  }, 15_000);
  const tagIds = [];
  for (const name of tagNames) {
    const slug = name.toLowerCase().replace(/ /gu, '-');
    const tag = await d.own(`tag/${slug}`, id => job.tag.findUnique({ where: id ? { id } : { slug } }),
      () => d.post('/admin/tags', token, { name }), row => row.slug === slug && row.active);
    tagIds.push(tag.id);
  }
  for (const plan of plans) await seedPack(d, plan, token, tagIds);
});
