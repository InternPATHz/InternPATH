import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@internpath/common';
import nodemailer from 'nodemailer';

@Injectable()
export class AuthMailer {
  constructor(private readonly config: ConfigService) {}

  async send(email: string, purpose: 'verify-email' | 'reset-password', token: string): Promise<void> {
    const base = this.config.get<string>('WEB_BASE_URL');
    const host = this.config.get<string>('SMTP_HOST');
    const port = Number(this.config.get<string>('SMTP_PORT') ?? 1025);
    if (!base || !host || !Number.isInteger(port) || port < 1) {
      throw new AppException('MAIL_NOT_CONFIGURED', 'ระบบอีเมลยังไม่ได้ตั้งค่า', 503);
    }
    const link = new URL(`/${purpose}`, base);
    link.searchParams.set('token', token);
    const transport = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: this.config.get<string>('SMTP_USER')
        ? { user: this.config.get<string>('SMTP_USER'), pass: this.config.get<string>('SMTP_PASSWORD') }
        : undefined,
    });
    try {
      await transport.sendMail({
        from: this.config.get<string>('SMTP_FROM') ?? 'InternPath <no-reply@internpath.local>',
        to: email,
        subject: purpose === 'verify-email' ? 'ยืนยันอีเมล InternPath' : 'รีเซ็ตรหัสผ่าน InternPath',
        text: `เปิดลิงก์นี้เพื่อ${purpose === 'verify-email' ? 'ยืนยันอีเมล' : 'รีเซ็ตรหัสผ่าน'}: ${link.toString()}`,
      });
    } catch {
      throw new AppException('MAIL_UNAVAILABLE', 'ส่งอีเมลไม่สำเร็จ กรุณาลองใหม่', 503);
    } finally {
      transport.close();
    }
  }
}
