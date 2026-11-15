import type {
  CompanyEntitlementChangedPayload,
  CompanyFlagChangedPayload,
  CompanyStatusChangedPayload,
  EventEnvelope,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';

@Injectable()
export class CompanySnapshotService {
  async handleCompanyStatusChanged(
    env: EventEnvelope<'CompanyStatusChanged', CompanyStatusChangedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    const data = {
      name: p.snapshot.name,
      logoKey: p.snapshot.logo_key ?? null,
      status: p.status,
      universityPartner: p.snapshot.university_partner,
      verifiedBadge: p.snapshot.verified_badge,
      entityVersion: p.entity_version,
      updatedAt: new Date(),
    };
    const update = () =>
      tx.companySnapshot.updateMany({
        where: { companyId: p.company_id, entityVersion: { lt: p.entity_version } },
        data,
      });
    if ((await update()).count > 0) return;
    const created = await tx.companySnapshot.createMany({
      data: [{ companyId: p.company_id, ...data }],
      skipDuplicates: true,
    });
    // Another transaction may insert an older version after our first update missed.
    if (created.count === 0) await update();
  }

  async handleCompanyEntitlementChanged(
    env: EventEnvelope<'CompanyEntitlementChanged', CompanyEntitlementChangedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    const data = {
      featuredEnabled: p.featured_enabled,
      fastTrackEnabled: p.fast_track_enabled,
      entityVersion: p.entity_version,
      updatedAt: new Date(),
    };
    const update = () =>
      tx.companyEntitlement.updateMany({
        where: { companyId: p.company_id, entityVersion: { lt: p.entity_version } },
        data,
      });
    if ((await update()).count > 0) return;
    const created = await tx.companyEntitlement.createMany({
      data: [{ companyId: p.company_id, ...data }],
      skipDuplicates: true,
    });
    if (created.count === 0) await update();
  }

  async handleCompanyFlagChanged(
    env: EventEnvelope<'CompanyFlagChanged', CompanyFlagChangedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    const data = {
      underReview: p.active,
      entityVersion: p.entity_version,
      updatedAt: new Date(),
    };
    const update = () =>
      tx.companyFlag.updateMany({
        where: { companyId: p.company_id, entityVersion: { lt: p.entity_version } },
        data,
      });
    if ((await update()).count > 0) return;
    const created = await tx.companyFlag.createMany({
      data: [{ companyId: p.company_id, ...data }],
      skipDuplicates: true,
    });
    if (created.count === 0) await update();
  }
}
