import { randomUUID } from 'node:crypto';
import { AppException } from '@internpath/common';
import type { ConsentCheckResponse, InternalStudentNamesResponse, InternalStudentResponse } from '@internpath/contracts';

/**
 * ตัวปลอมในหน่วยความจำสำหรับเทสต์ 1.3 (โปรไฟล์/เรซูเม่) — รองรับเฉพาะ query ที่ ProfilesService/ResumesService ใช้
 * (ตั้งชื่อแยกจาก fake-prisma ของ 1.2 เพื่อไม่ชนกันตอน merge)
 */

type Row = Record<string, any>;

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (value === null) return row[key] === null || row[key] === undefined;
    return row[key] === value;
  });
}

function sortRows(rows: Row[], orderBy?: Row | Row[]): Row[] {
  const orders = orderBy ? (Array.isArray(orderBy) ? orderBy : [orderBy]) : [];
  return [...rows].sort((a, b) => {
    for (const order of orders) {
      const [key, dir] = Object.entries(order)[0];
      const av = a[key] instanceof Date ? a[key].getTime() : Number(a[key]);
      const bv = b[key] instanceof Date ? b[key].getTime() : Number(b[key]);
      if (av !== bv) return dir === 'desc' ? bv - av : av - bv;
    }
    return 0;
  });
}

const pick = (row: Row, select?: Row): Row =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

export class FakePrisma {
  profiles: Row[] = [];
  resumes: Row[] = [];
  applications: Row[] = [];
  executeRawCalls = 0;
  /** ตั้งให้ resume.create โยน error (ทดสอบการลบไฟล์ชดเชย) */
  failResumeCreate = false;
  /**
   * จำลองแพ้การแข่งตอนสร้างโปรไฟล์ครั้งแรก: upsert ครั้งถัดไปจะเพิ่มแถวนี้แทน "อีกคำขอ" แล้วโยน P2002
   * เหมือน Postgres เมื่อสองคำขอผ่าน findUnique พร้อมกัน
   */
  profileRaceWinner: Row | null = null;

  studentProfile = {
    findUnique: async ({ where }: { where: Row }) => {
      const row = this.profiles.find((p) => matches(p, where));
      return row ? { ...row } : null;
    },
    count: async ({ where }: { where: Row }) => this.profiles.filter((p) => matches(p, where)).length,
    upsert: async ({ where, create, update }: { where: Row; create: Row; update: Row }) => {
      if (this.profileRaceWinner) {
        const winner = { headline: null, bio: null, portfolioUrl: null, skills: [], createdAt: new Date(), updatedAt: new Date(),
          ...this.profileRaceWinner };
        this.profileRaceWinner = null;
        this.profiles.push(winner);
        throw Object.assign(new Error('Unique constraint failed on the fields: (`user_id`)'), { code: 'P2002' });
      }
      const row = this.profiles.find((p) => matches(p, where));
      if (row) {
        Object.assign(row, update, { updatedAt: new Date() });
        return { ...row };
      }
      const created = { headline: null, bio: null, portfolioUrl: null, skills: [], createdAt: new Date(), updatedAt: new Date(), ...create };
      this.profiles.push(created);
      return { ...created };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.profiles.find((p) => matches(p, where));
      if (!row) throw new Error('P2025 record not found');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  };

  resume = {
    count: async ({ where }: { where: Row }) => this.resumes.filter((r) => matches(r, where)).length,
    create: async ({ data }: { data: Row }) => {
      if (this.failResumeCreate) throw new Error('db down');
      const row = { id: randomUUID(), mime: 'application/pdf', isPrimary: false, uploadedAt: new Date(), deletedAt: null, ...data };
      this.resumes.push(row);
      return { ...row };
    },
    findMany: async ({ where, orderBy, skip = 0, take }: { where: Row; orderBy?: Row | Row[]; skip?: number; take?: number }) => {
      const rows = sortRows(this.resumes.filter((r) => matches(r, where)), orderBy);
      return rows.slice(skip, take === undefined ? undefined : skip + take).map((r) => ({ ...r }));
    },
    findFirst: async ({ where, orderBy }: { where: Row; orderBy?: Row | Row[] }) => {
      const row = sortRows(this.resumes.filter((r) => matches(r, where)), orderBy)[0];
      return row ? { ...row } : null;
    },
    updateMany: async ({ where, data }: { where: Row; data: Row }) => {
      const rows = this.resumes.filter((r) => matches(r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    },
    update: async ({ where, data }: { where: Row; data: Row }) => {
      const row = this.resumes.find((r) => matches(r, where));
      if (!row) throw new Error('P2025 record not found');
      Object.assign(row, data);
      return { ...row };
    },
  };

  application = {
    findUnique: async ({ where, select }: { where: Row; select?: Row }) => {
      const row = this.applications.find((a) => matches(a, where));
      return row ? pick(row, select) : null;
    },
  };

  async $transaction<T>(fn: (tx: FakePrisma) => Promise<T>): Promise<T> {
    return fn(this);
  }

  async $executeRaw(): Promise<number> {
    this.executeRawCalls += 1;
    return 0;
  }

  /** เพิ่มเรซูเม่ตรงๆ (ข้าม service) */
  addResume(data: Row): Row {
    const row = { id: randomUUID(), objectKey: `resumes/${randomUUID()}.pdf`, mime: 'application/pdf', sizeBytes: 1000,
      isPrimary: false, uploadedAt: new Date(), deletedAt: null, ...data };
    this.resumes.push(row);
    return row;
  }

  addApplication(data: Row): Row {
    const row = { id: randomUUID(), advisorUserId: null, resumeId: null, ...data };
    this.applications.push(row);
    return row;
  }
}

export class FakeStorage {
  objects = new Map<string, Buffer>();
  deleted: string[] = [];
  signed: Array<{ key: string; ttl: number }> = [];
  failDelete = false;

  generateKey(prefix?: string, extension?: string): string {
    const ext = extension ? `.${extension.replace(/^\./, '')}` : '';
    return `${prefix ? `${prefix}/` : ''}${randomUUID()}${ext}`;
  }

  async upload(key: string, body: Buffer): Promise<{ key: string; sizeBytes: number }> {
    this.objects.set(key, Buffer.from(body));
    return { key, sizeBytes: body.length };
  }

  async getSignedDownloadUrl(key: string, ttl = 600): Promise<string> {
    this.signed.push({ key, ttl });
    return `https://storage.test/${key}?X-Amz-Expires=${ttl}&sig=fake`;
  }

  async delete(key: string): Promise<void> {
    if (this.failDelete) throw new Error('storage down');
    this.objects.delete(key);
    this.deleted.push(key);
  }
}

export class FakeIdentity {
  students = new Map<string, InternalStudentResponse>();
  /** คู่ `${student}:${company}` ที่มี Consent */
  consents = new Set<string>();
  unavailable = false;
  consentCalls: Array<{ student: string; company: string }> = [];

  setStudent(userId: string, data: Partial<InternalStudentResponse> = {}): void {
    this.students.set(userId, {
      full_name: 'สมชาย ใจดี',
      major: 'วิศวกรรมคอมพิวเตอร์',
      year_level: 3,
      university_id: randomUUID(),
      email_verified: true,
      advisor_link_status: 'NONE',
      ...data,
    } as InternalStudentResponse);
  }

  async getStudent(userId: string): Promise<InternalStudentResponse> {
    if (this.unavailable) throw new AppException('UPSTREAM_UNAVAILABLE', 'identity down', 502);
    const student = this.students.get(userId);
    if (!student) throw new AppException('NOT_FOUND', 'ไม่พบนักศึกษา', 404);
    return { ...student };
  }

  async checkConsent(student: string, company: string): Promise<ConsentCheckResponse> {
    if (this.unavailable) throw new AppException('UPSTREAM_UNAVAILABLE', 'identity down', 502);
    this.consentCalls.push({ student, company });
    return { has_consent: this.consents.has(`${student}:${company}`) };
  }

  /** `GET /internal/v1/students/names?ids=` — แต่ละครั้งที่เรียก (ตรวจการแบ่ง batch ≤ 100) */
  nameCalls: string[][] = [];

  async getStudentNames(ids: readonly string[]): Promise<InternalStudentNamesResponse> {
    if (this.unavailable) throw new AppException('UPSTREAM_UNAVAILABLE', 'identity down', 502);
    this.nameCalls.push([...ids]);
    return ids.flatMap((id) => {
      const student = this.students.get(id);
      return student ? [{ user_id: id, full_name: student.full_name }] : [];
    });
  }
}

/** ไฟล์ตัวอย่างสำหรับตรวจ MIME จริง */
export const SAMPLE_FILES = {
  pdf: (): Buffer => Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'latin1'),
  /** ไฟล์ Windows executable (ขึ้นต้นด้วย MZ + PE header) — ใช้แทน `.exe` ที่เปลี่ยนนามสกุลเป็น `.pdf` */
  exe: (): Buffer => {
    const buf = Buffer.alloc(512);
    buf.write('MZ', 0, 'latin1');
    buf.writeUInt32LE(0x80, 0x3c);
    buf.write('PE\0\0', 0x80, 'latin1');
    return buf;
  },
  png: (): Buffer => Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex'),
  text: (): Buffer => Buffer.from('just some text pretending to be a pdf', 'utf8'),
  /** PDF ที่ใหญ่เกิน 5 MB */
  oversizedPdf: (): Buffer => Buffer.concat([Buffer.from('%PDF-1.4\n', 'latin1'), Buffer.alloc(5 * 1024 * 1024 + 1, 0x20)]),
};
