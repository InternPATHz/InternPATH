import { Blob, Buffer } from 'node:buffer';
import { check, sha256 } from './runtime.mjs';

export const adminEmail = 'admin@demo.internpath.test';
export const defaultPacks = ['a', 'b', 'c'];
export const categories = ['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES'];
export const tagNames = ['Demo Backend', 'Demo Research', 'Demo Analytics'];
export const major = 'เทคโนโลยีสารสนเทศ';
const companies = ['สายธาร สตูดิโอ', 'Mango Labs', 'Lantern Works', 'ชบา ดิจิทัล'];
const names = { flow: 'ปั้น ฝึกงาน', certificate: 'Mali Certificate', problem: 'ฟ้า รายงาน',
  offer: 'Nalin Offer', overdue: 'ต้น ติดตามผล' };
const jobTitles = ['Web Platform', 'Content Strategy', 'People Operations', 'Quality Assurance',
  'Community Outreach', 'Finance Operations', 'Data Analytics', 'Brand Research',
  'Project Coordination', 'Cloud Support', 'Product Marketing', 'Customer Experience', 'API Engineering'];

export const bangkokDate = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format();
export function day(anchor, offset = 0) {
  return new Date(Date.parse(anchor + 'T00:00:00Z') + offset * 86_400_000).toISOString().slice(0, 10);
}
export const date = (s, time = '10:00:00') => new Date(`${s}T${time}+07:00`);
const registration = name => '99' + (BigInt('0x' + sha256(name).slice(0, 14)) % 100_000_000_000n).toString().padStart(11, '0');

export function requestedPacks(args) {
  if (!args.length) return defaultPacks;
  check(args.length === 2 && args[0] === '--pack' && /^[a-z][a-z0-9-]{0,19}$/u.test(args[1]) && args[1] !== 'display',
    'Use pnpm demo:seed --pack <name> (lowercase letters, numbers and hyphens).');
  return [args[1]];
}

export function scenario(name) {
  const display = name === 'display';
  const label = name.toUpperCase();
  const school = `demo-seed-${name}.ac.th`;
  const org = (kind) => {
    const domain = `${name}-${kind}.demo.internpath.test`;
    const index = ['display', 'a', 'b', 'c'].indexOf(name);
    return { domain, email: `owner@${domain}`, registration: registration(domain),
      title: `[Demo ${label}] ${companies[index < 0 ? 3 : index]}${kind === 'approval' ? ' Academy' : ''}` };
  };
  const students = Object.fromEntries((display ? ['certificate', 'problem', 'offer', 'overdue'] : ['flow', 'certificate', 'problem', 'offer'])
    .map(kind => [kind, { email: `${kind}@${school}`, code: `DEMO-${label}-${kind.toUpperCase()}`, name: names[kind] }]));
  const jobs = display ? jobTitles.map((title, i) => ({ key: `published-${i + 1}`, title, category: categories[i % categories.length], status: 'PUBLISHED' })) :
    [{ key: 'published-1', title: 'Digital Internship', category: categories[0], status: 'PUBLISHED' }];
  jobs.push({ key: 'draft', title: 'Product Studio Trainee', category: categories[1], status: 'DRAFT' });
  if (display) jobs.push(
    { key: 'closed', title: 'Operations Archive', category: categories[2], status: 'CLOSED' },
    { key: 'review', title: 'Platform Review Queue', category: categories[0], status: 'VERIFYING' },
  );
  return { name, display, label, school, jobs, students, advisor: `advisor@${school}`, company: org('studio'),
    ...(display ? { member: `member@${org('studio').domain}` } : { approval: org('approval') }) };
}

export function syntheticPdf(title) {
  // ASCII fixture title only. The text, offsets and xref produce a real one-page PDF.
  const text = title.replace(/[^a-zA-Z0-9 .-]/gu, '-');
  const stream = `BT /F1 18 Tf 65 730 Td (${text}) Tj 0 -32 Td /F1 12 Tf (Synthetic InternPATH demonstration document) Tj ET\n`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`];
  let output = '%PDF-1.4\n';
  const offsets = objects.map((object, index) => {
    const offset = Buffer.byteLength(output);
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.map(offset => String(offset).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

export function upload(bytes, name, type, fields = {}) {
  const form = new globalThis.FormData();
  form.append('file', new Blob([bytes], { type }), name);
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

export const demoLogo = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAkklEQVR4nO3QMQ6AMAwDwL6XiQfzCTZGmJGA2kmaBlnybJ/c2rLOlXyBQAIJJFC2QKAk0Hbs+aAL8ZTRoBeKlRWnIU2hGsYUrYFNAzSYqSrIqAFMAv0S5KLpNZV8SKCKILupd6gwyGICViAQZ8ImUBBqgvsJUL+JKedAnyy+1gK64XyqvEBuyRcIJJBAAmULJged06T4aoCaqogAAAAASUVORK5CYII=', 'base64');
