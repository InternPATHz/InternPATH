import { expect } from 'chai';
import { ConfigService } from '@nestjs/config';
import type { UserSuspendedPayload } from '@internpath/contracts';
import { DenylistService } from '../../src/denylist/denylist.service';

const payload = (version: number, suspended: boolean): UserSuspendedPayload => ({
  user_id: 'user-1', suspended, entity_version: version, at: '2026-11-15T00:00:00Z',
});

describe('Gateway UserSuspended denylist', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('applies suspension and reinstatement immediately, ignoring older events', () => {
    const denylist = new DenylistService(new ConfigService());
    denylist.applyEvent(payload(2, true));
    expect(denylist.has('user-1')).to.equal(true);
    denylist.applyEvent(payload(2, false));
    denylist.applyEvent(payload(1, false));
    expect(denylist.has('user-1')).to.equal(true);
    denylist.applyEvent(payload(3, false));
    expect(denylist.has('user-1')).to.equal(false);
  });

  it('keeps an event received during an older HTTP refresh', async () => {
    const denylist = new DenylistService(new ConfigService({
      IDENTITY_SERVICE_SECRET_GATEWAY: 'x'.repeat(32),
      IDENTITY_URL: 'http://127.0.0.1:3001',
    }));
    let resolveFetch!: (response: Response) => void;
    globalThis.fetch = async () => new Promise<Response>((resolve) => { resolveFetch = resolve; });
    const refresh = denylist.refresh();
    denylist.applyEvent(payload(1, true));
    resolveFetch(new Response('[]', { status: 200 }));
    await refresh;
    expect(denylist.has('user-1')).to.equal(true);
    expect(denylist.isFresh()).to.equal(true);
  });

  it('rejects malformed events before changing the cache', () => {
    const denylist = new DenylistService(new ConfigService());
    expect(() => denylist.applyEvent({ ...payload(1, true), entity_version: Number.NaN })).to.throw();
    expect(denylist.has('user-1')).to.equal(false);
  });
});
