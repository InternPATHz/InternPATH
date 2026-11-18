import { Controller, Headers, HttpCode, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims } from '@internpath/common';
import { AccountDeletionService } from './account-deletion.service';

/**
 * `POST /users/me/deletion-request` (api-contract §4.2 — PM ตัดสิน 2026-11-17: **ซิงโครนัส**)
 * `request()` แล้ว `complete()` ในคำขอเดียว ⇒ `204` ไม่มี body และ token ถูกเพิกถอนทันที (denylist + ลบ refresh token)
 * - Owner ที่ยังไม่โอน / มีใบสมัครที่ดำเนินอยู่ (Lifecycle) ⇒ `422 DELETION_BLOCKED`
 * - ตรวจกับ Lifecycle ไม่ได้ ⇒ `503 UPSTREAM_UNAVAILABLE` (fail-closed — ไม่มีอะไรถูกลบ)
 */
@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class AccountDeletionController {
  constructor(private readonly service: AccountDeletionService) {}

  @Post('deletion-request')
  @HttpCode(204)
  async requestDeletion(@CurrentUser() actor: JwtClaims, @Headers('x-correlation-id') cid?: string): Promise<void> {
    const requestId = await this.service.request(actor.sub);
    await this.service.complete(requestId, cid);
  }
}
