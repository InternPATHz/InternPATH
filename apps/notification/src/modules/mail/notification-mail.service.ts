import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createTransport } from 'nodemailer';
import { IdentityClient } from '../../internal/identity-client';
import { PrismaService } from '../../prisma.service';
import { recipientKey } from '../../recipient-key';

const MAX_ATTEMPTS = 5;
const POLL_INTERVAL_MS = 10_000;

@Injectable()
export class NotificationMailService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(NotificationMailService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;

  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityClient,
    private readonly config: ConfigService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.deliverNext()
        .catch(() => this.log.error('Notification email delivery failed'))
        .finally(() => {
          this.running = undefined;
        });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async deliverNext(): Promise<boolean> {
    return this.db.$transaction(async (tx) => {
      // PENDING is committed by the consumer before SMTP. Concurrent workers skip locked deliveries.
      const [row] = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM delivery_logs
        WHERE channel = 'EMAIL' AND status IN ('PENDING', 'FAILED') AND attempts < ${MAX_ATTEMPTS}
        ORDER BY attempts, notification_id
        LIMIT 1 FOR UPDATE SKIP LOCKED
      `;
      if (!row) return false;
      const delivery = await tx.deliveryLog.findUniqueOrThrow({
        where: { id: row.id },
        include: { notification: true },
      });
      const state = await tx.recipientState.findUnique({
        where: { recipientKey: recipientKey(delivery.toUserId) },
      });
      const attempts = delivery.attempts + 1;
      try {
        const contact =
          state?.deleted || state?.suspended
            ? undefined
            : await this.identity.contact(delivery.toUserId);
        if (!contact) {
          await tx.deliveryLog.update({
            where: { id: row.id },
            data: { status: 'FAILED', error: 'RECIPIENT_UNAVAILABLE', attempts: MAX_ATTEMPTS },
          });
          return true;
        }
        await this.send(contact.email, delivery.notification);
      } catch {
        await tx.deliveryLog.update({
          where: { id: row.id },
          data: { status: 'FAILED', error: 'DELIVERY_FAILED', attempts },
        });
        return true;
      }
      await tx.deliveryLog.update({
        where: { id: row.id },
        data: { status: 'SENT', sentAt: new Date(), error: null, attempts },
      });
      return true;
    });
  }

  private async send(
    email: string,
    notice: { title: string; body: string; link: string | null },
  ): Promise<void> {
    const host = this.config.get<string>('SMTP_HOST');
    if (!host) throw new Error('SMTP host unavailable');
    const port = Number(this.config.get<string>('SMTP_PORT') ?? 1025);
    const user = this.config.get<string>('SMTP_USER');
    const transport = createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass: this.config.get<string>('SMTP_PASSWORD') } : undefined,
      connectionTimeout: 5000,
      greetingTimeout: 5000,
      socketTimeout: 10000,
    });
    const base = this.config.get<string>('WEB_BASE_URL', 'http://localhost:3100');
    const link = notice.link ? new URL(notice.link, base).href : undefined;
    try {
      await transport.sendMail({
        from: this.config.get<string>('SMTP_FROM', 'InternPath <no-reply@internpath.local>'),
        to: email,
        subject: notice.title,
        text: link ? `${notice.body}\n\n${link}` : notice.body,
      });
    } finally {
      transport.close();
    }
  }
}
