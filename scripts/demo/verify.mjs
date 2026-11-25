import { adminEmail, bangkokDate, defaultPacks, requestedPacks, scenario } from './scenarios.mjs';
import { check, cli, sha256 } from './runtime.mjs';

const history = ['PENDING', 'HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS'];
const asDay = date => date?.toISOString().slice(0, 10);
const thaiDay = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(date);

async function ownedUser(d, id, email, role) {
  const user = await d.db.identity.user.findUnique({ where: { id } });
  check(user?.email === email && user.role === role && user.status === 'ACTIVE' && user.emailVerifiedAt,
    `Demo account is unavailable: ${email}.`);
  return user;
}

async function pdf(d, url, hash) {
  const bytes = await d.storage(url);
  check(bytes.subarray(0, 5).toString() === '%PDF-' && (!hash || sha256(bytes) === hash), 'Download is missing, not a PDF, or has a mismatching SHA-256.');
  return bytes.length;
}

async function company(d, companyId, ownerId, spec, status) {
  const token = await d.login(spec.email, 'COMPANY_HR', ownerId);
  const { identity, job, lifecycle, verification } = d.db;
  const [org, member, docs] = await Promise.all([
    identity.company.findUnique({ where: { id: companyId } }),
    identity.companyMember.findUnique({ where: { userId: ownerId } }),
    d.api('/companies/me/documents', { token }),
  ]);
  check(org?.emailDomain === spec.domain && org.registrationNo === spec.registration && member?.companyId === companyId && member.memberRole === 'OWNER',
    'Demo company ownership or registration changed.');
  if (status) check(org.status === status, `Demo working company must be ${status}.`);
  const document = docs.find(doc => doc.doc_type === 'REGISTRATION_CERT');
  check(document, 'Company registration document is missing.');
  await pdf(d, document.url);
  const snapshots = await Promise.all([job, lifecycle, verification].map(db => db.companySnapshot.findUnique({ where: { companyId } })));
  check(snapshots.every(row => row?.status === org.status), 'Company projections have not caught up.');
  check(org.logoKey, 'Synthetic company logo is missing.');
  const logo = await d.storage(await d.api('/companies/me', { token }).then(item => item.logo_url), { signed: false });
  check(logo.subarray(1, 4).toString() === 'PNG', 'Synthetic logo download did not return a PNG.');
  return org;
}

async function application(d, pack, role) {
  const ids = pack.students[role];
  const id = pack.applications[role];
  const { lifecycle, identity, job } = d.db;
  const app = await lifecycle.application.findUniqueOrThrow({ where: { id },
    include: { evaluations: true, certificate: true, review: true, problemReports: true } });
  const [rows, resume, consent, reservation, snapshot] = await Promise.all([
    lifecycle.statusHistory.findMany({ where: { entity: 'APPLICATION', entityId: id }, orderBy: { occurredAt: 'asc' } }),
    lifecycle.resume.findUnique({ where: { id: ids.resumeId } }),
    identity.consent.findUnique({ where: { id: ids.consentId } }),
    job.quotaReservation.findUnique({ where: { applicationId: id } }),
    lifecycle.jobSnapshot.findUnique({ where: { jobId: pack.jobs['published-1'] } }),
  ]);
  check(app.studentUserId === ids.id && app.advisorUserId === pack.advisorId && app.companyId === pack.companyId &&
    app.jobId === pack.jobs['published-1'] && app.resumeId === ids.resumeId && app.resumeConsentId === ids.consentId &&
    snapshot?.companyId === pack.companyId && snapshot.status === 'PUBLISHED', 'Historical application references changed.');
  check(resume?.studentUserId === ids.id && !resume.deletedAt && consent?.userId === ids.id && !consent.revokedAt &&
    consent.type === 'RESUME_SHARE' && consent.targetCompanyId === pack.companyId, 'Historical resume and consent are inconsistent.');
  check(reservation?.jobId === app.jobId && reservation.status === 'CONFIRMED', 'Historical Job reservation is not confirmed.');
  const actors = [ids.id, pack.ownerId, ids.id, pack.advisorId, pack.ownerId];
  const roles = ['STUDENT', 'COMPANY_HR', 'STUDENT', 'ADVISOR', 'COMPANY_HR'];
  check(rows.length >= history.length && rows.at(-1).toStatus === app.status &&
    rows.every((row, i) => (!i || (row.occurredAt > rows[i - 1].occurredAt && row.fromStatus === rows[i - 1].toStatus))) &&
    history.every((toStatus, i) => rows[i].toStatus === toStatus && rows[i].actorId === actors[i] && rows[i].actorRole === roles[i]) &&
    thaiDay(rows[3].occurredAt) <= asDay(app.actualStartDate) && thaiDay(rows[4].occurredAt) === asDay(app.actualStartDate),
    'Historical status history is not an ordered, owned timeline.');
  check(app.endDate && app.actualStartDate && (app.endDate - app.actualStartDate) / 86_400_000 >= 30,
    'Historical fixture must span at least 30 internship days.');
  check(app.evaluations.every(row => thaiDay(row.evaluatedAt) >= asDay(app.endDate)), 'A demo evaluation predates the recorded end date.');
  return app;
}

async function certificate(d, app, student) {
  const cert = app.certificate;
  if (!cert) return;
  const actualDays = (app.actualEndDate - app.actualStartDate) / 86_400_000;
  check(cert.status === 'VALID' && actualDays >= 30 && cert.actualDays === actualDays &&
    cert.studentUserId === app.studentUserId && cert.companyId === app.companyId &&
    +cert.periodStart === +app.actualStartDate && +cert.periodEnd === +app.actualEndDate &&
    app.evaluations.some(row => row.result === 'PASS' && row.evaluatedAt <= cert.issuedAt),
    'Invalid certificate eligibility, period, or ownership.');
  check(await d.db.lifecycle.certificate.count({ where: { certificateCode: cert.certificateCode } }) === 1,
    'Certificate code is not unique.');
  const token = await d.login(student.email, 'STUDENT', app.studentUserId);
  const { url } = await d.api(`/me/certificates/${cert.id}/download`, { token });
  const bytes = await pdf(d, url, cert.pdfSha256);
  const record = await d.api(`/public/certificates/${cert.certificateCode}`);
  check(record.status === 'VALID' && record.job_title === cert.jobTitleSnapshot && record.company_name === cert.companyNameSnapshot,
    'Public certificate verification differs from Lifecycle.');
  console.log(`  Certificate ${cert.certificateCode}: VALID, ${bytes} bytes, SHA-256 matched.`);
}

async function notifications(d, items) {
  for (const [type, aggregateId, userIds] of items) {
    const events = await d.db.lifecycle.outboxEvent.findMany({ where: { type, aggregateId, publishedAt: { not: null } }, select: { id: true } });
    check(events.length > 0, `Missing published ${type} event.`);
    for (const userId of userIds) {
      check(await d.db.notification.notification.count({ where: { sourceEventId: { in: events.map(e => e.id) }, userId } }) > 0,
        `Missing ${type} notification for a demo recipient.`);
    }
  }
}

async function verifyPack(d, name) {
  const pack = d.manifest.packs[name];
  check(pack?.complete, 'Pack has not been seeded completely.');
  const spec = scenario(name);
  const { identity, job, lifecycle, verification } = d.db;
  const adminId = d.manifest.entries.admin.id;
  await Promise.all([
    ownedUser(d, pack.ownerId, spec.company.email, 'COMPANY_HR'), ownedUser(d, pack.advisorId, spec.advisor, 'ADVISOR'),
    ...Object.entries(spec.students).map(([kind, row]) => ownedUser(d, pack.students[kind].id, row.email, 'STUDENT')),
  ]);
  for (const row of Object.values(pack.students)) {
    const link = await lifecycle.studentAdvisorLink.findUnique({ where: { studentUserId: row.id } });
    check(link?.advisorUserId === pack.advisorId && link.linkStatus === 'LINKED', 'Lifecycle student-advisor projection is inconsistent.');
  }
  const org = await company(d, pack.companyId, pack.ownerId, spec.company, 'VERIFIED');
  const publicCompany = await d.api(`/directory/companies/${org.id}`);
  check(publicCompany.name === org.name, 'Public Directory shows the wrong company.');
  const reviews = await lifecycle.review.findMany({ where: { companyId: org.id, status: 'PUBLISHED' } });
  const average = reviews.length ? reviews.reduce((sum, row) => sum + row.rating, 0) / reviews.length : 0;
  const projection = await identity.companyRatingStats.findUnique({ where: { companyId: org.id } });
  check(publicCompany.review_count === reviews.length && publicCompany.rating_avg === average &&
    (projection?.reviewCount ?? 0) === reviews.length && (projection?.ratingSum ?? 0) === reviews.reduce((sum, row) => sum + row.rating, 0),
    'Directory review counters differ from Lifecycle.');
  const published = await d.api(`/companies/${org.id}/reviews?page_size=100`);
  check(published.meta.total === reviews.length && reviews.every(review => published.data.some(row => row.id === review.id)),
    'Published review visibility is inconsistent.');

  const consumed = [];
  for (const value of spec.jobs) {
    const row = await job.job.findUniqueOrThrow({ where: { id: pack.jobs[value.key] } });
    check(row.companyId === org.id && row.category === value.category, 'Demo job belongs to another company or category.');
    if (!spec.display && value.key === 'draft' && row.status !== 'DRAFT') consumed.push('draft job changed');
    else if (value.status === 'VERIFYING') check(['VERIFYING', 'PENDING_REVIEW'].includes(row.status), 'Display job no longer awaits verification.');
    else check(row.status === value.status, `Unexpected job status for ${value.key}.`);
    if (value.status === 'PUBLISHED') {
      check(asDay(row.applicationDeadline) >= bangkokDate(), 'A published demo job application deadline has passed.');
      const [lc, vf, detail, reserved, confirmed] = await Promise.all([
        lifecycle.jobSnapshot.findUnique({ where: { jobId: row.id } }), verification.jobSnapshot.findUnique({ where: { jobId: row.id } }),
        d.api(`/jobs/${row.id}`), job.quotaReservation.count({ where: { jobId: row.id, status: 'RESERVED' } }),
        job.quotaReservation.count({ where: { jobId: row.id, status: 'CONFIRMED' } }),
      ]);
      check(lc?.companyId === org.id && lc.status === 'PUBLISHED' && vf?.companyId === org.id && vf.status === 'PUBLISHED' &&
        detail.status === 'PUBLISHED' && row.quotaReserved === reserved && row.quotaConfirmed === confirmed &&
        detail.quota_available === row.quota - reserved - confirmed && row.quota > reserved + confirmed,
        'Public job projections or quota totals are inconsistent.');
    }
  }
  const search = await d.api(`/search/jobs?q=${encodeURIComponent(`[Demo ${spec.label}]`)}&page_size=10`);
  check(search.meta.total >= spec.jobs.filter(row => row.status === 'PUBLISHED').length, 'Demo jobs do not appear in search.');
  const applications = {};
  const hr = await d.login(spec.company.email, 'COMPANY_HR', pack.ownerId);
  for (const kind of Object.keys(pack.applications)) {
    const app = await application(d, pack, kind);
    const { url } = await d.api(`/hr/applications/${app.id}/resume`, { token: hr });
    await pdf(d, url);
    applications[kind] = app;
  }
  await certificate(d, applications.certificate, spec.students.certificate);

  if (spec.display) {
    check(search.meta.total > 10 && search.data.length === 10, 'Display jobs do not fill two pages.');
    const page2 = await d.api(`/search/jobs?q=${encodeURIComponent(`[Demo ${spec.label}]`)}&page_size=10&page=2`);
    check(page2.meta.total === search.meta.total && page2.data.length > 0 &&
      page2.data.every(item => !search.data.some(row => row.id === item.id)), 'Display job pagination is inconsistent.');
    const { artifacts } = pack;
    const complete = applications.certificate;
    check(complete.status === 'COMPLETED' && complete.academicResult === 'ACADEMIC_PASS' && complete.academicRecordedAt &&
      complete.certificate?.id === artifacts.certificateId && complete.review?.id === artifacts.reviewId && complete.review.status === 'PUBLISHED',
      'Demo completed internship is inconsistent.');
    const offer = await lifecycle.application.findUnique({ where: { id: artifacts.offerId } });
    check(offer?.status === 'HR_ACCEPTED' && offer.studentUserId === pack.students.offer.id &&
      (await job.quotaReservation.findUnique({ where: { applicationId: offer.id } }))?.status === 'RESERVED',
      'Display offer or reservation is missing.');
    check(applications.problem.problemReports.some(row => row.id === artifacts.problemId && row.status === 'OPEN'), 'Display problem report is missing.');
    const member = await ownedUser(d, pack.memberId, spec.member, 'COMPANY_HR');
    check((await identity.companyMember.findUnique({ where: { userId: member.id } }))?.memberRole === 'MEMBER', 'HR Member is missing.');
    const admin = await d.login(adminEmail, 'PLATFORM_ADMIN', adminId);
    const [reviewQueue, jobQueue, overdue, problems, audit] = await Promise.all([
      d.api(`/admin/queue?type=REVIEW_REPORT&target_id=${artifacts.reviewId}`, { token: admin }),
      d.api(`/admin/queue?type=JOB_REVIEW&target_id=${pack.jobs.review}`, { token: admin }),
      d.api('/admin/lifecycle/no-evaluation-candidates?page_size=100', { token: admin }),
      d.api('/admin/lifecycle/problem-reports?page_size=100', { token: admin }),
      identity.adminAuditLog.count({ where: { targetId: org.id, adminId } }),
    ]);
    check(reviewQueue.meta.total === 1 && jobQueue.meta.total === 1 &&
      overdue.data.some(row => row.id === pack.applications.overdue) &&
      problems.data.some(row => row.id === artifacts.problemId) && audit > 0, 'Demo Admin queues or audit are incomplete.');
    await notifications(d, [
      ['CertificateIssued', artifacts.certificateId, [pack.students.certificate.id]],
      ['ReviewPublished', org.id, [pack.ownerId]],
      ['ProblemReportCreated', artifacts.problemId, [pack.advisorId, adminId]],
    ]);
    return 'DISPLAY READY';
  }

  await ownedUser(d, pack.approvalOwnerId, spec.approval.email, 'COMPANY_HR');
  const offer = await lifecycle.application.findUnique({ where: { id: pack.artifacts.offerId } });
  check(offer?.studentUserId === pack.students.offer.id && offer.companyId === pack.companyId &&
    offer.jobId === pack.jobs['published-1'], 'Synthetic offer application belongs to another pack.');
  if (offer.status !== 'PENDING') consumed.push('sample offer changed');
  const approval = await company(d, pack.approvalId, pack.approvalOwnerId, spec.approval);
  if (approval.status !== 'PENDING') consumed.push(`approval company ${approval.status}`);
  if (await job.job.count({ where: { companyId: pack.companyId, id: { notIn: Object.values(pack.jobs) } } })) consumed.push('new HR job');
  if (await lifecycle.application.count({ where: { studentUserId: pack.students.flow.id, companyId: pack.companyId } })) consumed.push('student applied');
  if (applications.certificate.status !== 'IN_PROGRESS' || applications.certificate.evaluations.length || applications.certificate.certificate ||
    applications.certificate.review) consumed.push('certificate scenario used');
  if (applications.problem.status !== 'IN_PROGRESS' || applications.problem.problemReports.length) consumed.push('problem report scenario used');
  check(asDay(applications.certificate.endDate) < bangkokDate(), 'Live certificate requires a past end date.');
  return consumed.length ? `CONSUMED (${consumed.join(', ')})` : 'READY';
}

await cli('verify', async d => {
  for (const [key, entry] of Object.entries(d.manifest.entries)) {
    if (!key.startsWith('tag/')) continue;
    const tag = await d.db.job.tag.findUnique({ where: { id: entry.id } });
    check(tag?.slug === key.slice(4) && tag.active, 'A seeded demo tag is missing or inactive.');
  }
  const args = process.argv.slice(2);
  const names = args.length ? requestedPacks(args) : [...new Set([...defaultPacks, ...Object.keys(d.manifest.packs).filter(name => name !== 'display')])];
  const totals = { pass: 0, fail: 0, blocked: 0, ready: 0, consumed: 0 };
  for (const name of ['display', ...names]) {
    try {
      if (!d.manifest.packs[name]?.complete) {
        totals.blocked++;
        console.log(`${name.toUpperCase()}: BLOCKED — seed is incomplete.`);
        continue;
      }
      const outcome = await verifyPack(d, name);
      totals.pass++;
      if (outcome === 'READY') totals.ready++;
      if (outcome.startsWith('CONSUMED')) totals.consumed++;
      console.log(`${name.toUpperCase()}: PASS — ${outcome}.`);
    } catch (error) {
      totals.fail++;
      console.log(`${name.toUpperCase()}: FAIL — ${error.name === 'DemoError' ? error.message : error.code ?? error.name}.`);
    }
  }
  console.log(`PASS ${totals.pass} / FAIL ${totals.fail} / BLOCKED ${totals.blocked}; READY ${totals.ready}, CONSUMED ${totals.consumed}.`);
  if (totals.fail || totals.blocked) process.exitCode = 1;
});
