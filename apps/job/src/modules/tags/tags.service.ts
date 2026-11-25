import { AppException } from '@internpath/common';
import type { AdminTag, JobTag, Paginated } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { AdminTagListQuery, TagListQuery } from './dto';

/** ชื่อ → slug (ตัวพิมพ์เล็ก a-z0-9 และขีด): `C#` → `csharp`, `C++` → `cplusplus`, `Node.js` → `nodejs` */
export function slugify(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll('#', 'sharp')
    .replaceAll('+', 'plus')
    .replaceAll('.', '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const PUBLIC_SELECT = { id: true, name: true, slug: true } as const;

@Injectable()
export class TagsService {
  constructor(private readonly db: PrismaService) {}

  /** `GET /tags` (Public): เฉพาะ Tag ที่ใช้งานอยู่ เรียงตามชื่อ */
  async listActive(q: TagListQuery): Promise<Paginated<JobTag>> {
    const where: Prisma.TagWhereInput = { active: true, ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}) };
    const [data, total] = await this.db.$transaction([
      this.db.tag.findMany({ where, select: PUBLIC_SELECT, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.page_size, take: q.page_size }),
      this.db.tag.count({ where }),
    ]);
    return { data, meta: { page: q.page, page_size: q.page_size, total } };
  }

  /** `GET /admin/tags`: รวมที่ปิดใช้งาน พร้อมจำนวนประกาศที่ติด Tag */
  async listAdmin(q: AdminTagListQuery): Promise<Paginated<AdminTag>> {
    const where: Prisma.TagWhereInput = {
      ...(q.active === undefined ? {} : { active: q.active }),
      ...(q.q ? { name: { contains: q.q, mode: 'insensitive' } } : {}),
    };
    const [rows, total] = await this.db.$transaction([
      this.db.tag.findMany({
        where,
        select: { ...PUBLIC_SELECT, active: true, _count: { select: { jobs: true } } },
        orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (q.page - 1) * q.page_size,
        take: q.page_size,
      }),
      this.db.tag.count({ where }),
    ]);
    const data = rows.map(({ _count, ...tag }) => ({ ...tag, job_count: _count.jobs }));
    return { data, meta: { page: q.page, page_size: q.page_size, total } };
  }

  async create(name: string, adminId: string): Promise<AdminTag> {
    const slug = this.slugOrThrow(name);
    try {
      const tag = await this.db.tag.create({ data: { name, slug, createdBy: adminId, updatedBy: adminId }, select: { ...PUBLIC_SELECT, active: true } });
      return { ...tag, job_count: 0 };
    } catch (cause) {
      throw this.mapConflict(cause);
    }
  }

  /** เปลี่ยนชื่อได้ (slug คงเดิม) หรือเปิด/ปิดใช้งาน — ปิดแล้วไม่ขึ้นให้เลือกใหม่ แต่ประกาศเดิมยังติด Tag อยู่ */
  async update(id: string, patch: { name?: string; active?: boolean }, adminId: string): Promise<AdminTag> {
    if (patch.name === undefined && patch.active === undefined) {
      throw new AppException('VALIDATION_FAILED', 'ไม่มีฟิลด์ที่แก้ไข', 400, [{ field: 'name', issue: 'EMPTY_PATCH' }]);
    }
    if (patch.name !== undefined) {
      this.slugOrThrow(patch.name);
      // slug คงเดิมตอนเปลี่ยนชื่อ จึงต้องกันชื่อซ้ำกับ Tag อื่นเอง (ไม่สนตัวพิมพ์)
      const clash = await this.db.tag.findFirst({ where: { name: { equals: patch.name, mode: 'insensitive' }, id: { not: id } }, select: { id: true } });
      if (clash) throw this.mapConflict(new Prisma.PrismaClientKnownRequestError('duplicate', { code: 'P2002', clientVersion: 'n/a' }));
    }
    try {
      const tag = await this.db.tag.update({
        where: { id },
        data: { ...(patch.name === undefined ? {} : { name: patch.name }), ...(patch.active === undefined ? {} : { active: patch.active }), updatedBy: adminId },
        select: { ...PUBLIC_SELECT, active: true, _count: { select: { jobs: true } } },
      });
      const { _count, ...rest } = tag;
      return { ...rest, job_count: _count.jobs };
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') throw new AppException('NOT_FOUND', 'ไม่พบ Tag', 404);
      throw this.mapConflict(cause);
    }
  }

  /**
   * ลบได้เฉพาะ Tag ที่ไม่มีประกาศใช้เลย (รวมประกาศที่ปิด/ถูกลบสถานะแล้ว) — Tag ที่ถูกใช้ให้ "ปิดใช้งาน" แทน
   * เพื่อไม่ให้ประกาศเดิมเสีย Tag ไป ถ้ามีประกาศเพิ่ม Tag นี้ระหว่างลบ FK ของ job_tags จะกันไว้ (P2003)
   */
  async remove(id: string): Promise<void> {
    const inUse = () => new AppException('STATE_CONFLICT', 'Tag นี้มีประกาศใช้อยู่ ให้ปิดใช้งานแทนการลบ', 409, [{ field: 'id', issue: 'TAG_IN_USE' }]);
    const tag = await this.db.tag.findUnique({ where: { id }, select: { _count: { select: { jobs: true } } } });
    if (!tag) throw new AppException('NOT_FOUND', 'ไม่พบ Tag', 404);
    if (tag._count.jobs > 0) throw inUse();
    try {
      await this.db.tag.delete({ where: { id } });
    } catch (cause) {
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2025') throw new AppException('NOT_FOUND', 'ไม่พบ Tag', 404);
      if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2003') throw inUse();
      throw cause;
    }
  }

  private slugOrThrow(name: string): string {
    const slug = slugify(name);
    if (!slug) throw new AppException('VALIDATION_FAILED', 'ชื่อ Tag ต้องมีตัวอักษรภาษาอังกฤษหรือตัวเลข', 400, [{ field: 'name', issue: 'TAG_NAME_INVALID' }]);
    return slug;
  }

  private mapConflict(cause: unknown): unknown {
    if (cause instanceof Prisma.PrismaClientKnownRequestError && cause.code === 'P2002') {
      return new AppException('STATE_CONFLICT', 'มี Tag ชื่อนี้อยู่แล้ว', 409, [{ field: 'name', issue: 'TAG_EXISTS' }]);
    }
    return cause;
  }
}
