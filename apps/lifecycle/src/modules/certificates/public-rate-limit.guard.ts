import { AppException } from '@internpath/common';
import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';

const WINDOW_MS = 60_000;
/** เก็บได้ไม่เกินกี่ IP ก่อนล้างหน้าต่างที่หมดอายุ (กันหน่วยความจำโตไม่หยุดเมื่อถูกไล่ยิงจากหลาย IP) */
const PRUNE_AT = 10_000;

/**
 * ชั้นกันที่ Service ของหน้าตรวจใบรับรองสาธารณะ (README §5.4, §5.7) — Gateway จำกัด 30 ครั้ง/นาที/IP อยู่แล้ว
 * อันนี้กันกรณีเรียก Service ตรง/Gateway ตั้งผิด: หน้าต่างคงที่ 1 นาทีต่อ IP ในหน่วยความจำ (ต่อ instance)
 * IP: `X-Forwarded-For` ตัวแรกที่ Gateway ตั้งให้ (Gateway ลบค่าจาก client ก่อน) ไม่มี ⇒ IP ของการเชื่อมต่อ
 * เกิน ⇒ `429 RATE_LIMITED` + `Retry-After` (api-contract §2)
 */
@Injectable()
export class PublicCertificateRateLimitGuard implements CanActivate {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly config: LifecycleConfigService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    // ตั้งก่อนทุกอย่าง ⇒ มีทั้งใน 200 และ 404/429 (`@Header` ของ Nest ใส่ให้เฉพาะตอนสำเร็จ)
    // noindex: ห้ามเครื่องมือค้นหาเก็บหน้า (README §5.4) • no-store: สถานะเปลี่ยนเป็น REVOKED ได้ทุกเมื่อ
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Cache-Control', 'no-store');
    const max = await this.config.getNumber('PUBLIC_CERT_RATE_LIMIT_PER_MINUTE');
    const retryAfter = this.hit(clientIp(req), max, Date.now());
    if (retryAfter > 0) {
      res.setHeader('Retry-After', String(retryAfter));
      throw new AppException('RATE_LIMITED', 'เรียกตรวจสอบใบรับรองถี่เกินไป กรุณาลองใหม่ภายหลัง', 429);
    }
    return true;
  }

  /** คืนจำนวนวินาทีที่ต้องรอ (0 = ผ่าน) */
  hit(ip: string, max: number, now: number): number {
    if (this.windows.size >= PRUNE_AT) {
      for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
    }
    const window = this.windows.get(ip);
    if (!window || window.resetAt <= now) {
      this.windows.set(ip, { count: 1, resetAt: now + WINDOW_MS });
      return 0;
    }
    window.count += 1;
    return window.count > max ? Math.max(1, Math.ceil((window.resetAt - now) / 1000)) : 0;
  }
}

function clientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0]?.trim();
  return first || req.ip || req.socket?.remoteAddress || 'unknown';
}
