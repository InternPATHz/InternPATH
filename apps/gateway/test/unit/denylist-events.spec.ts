import { expect } from 'chai';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { UserSuspendedPayload } from '@internpath/contracts';
import sinon from 'sinon';
import {
  DENYLIST_INITIAL_RETRY_MS, DENYLIST_REFRESH_INTERVAL_MS, DenylistService,
} from '../../src/denylist/denylist.service';

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

  describe('initial load retry', () => {
    let clock: sinon.SinonFakeTimers;
    let logged: sinon.SinonStub;
    let calls: number;
    let failuresLeft: number;
    let denylist: DenylistService;

    beforeEach(() => {
      clock = sinon.useFakeTimers({ now: Date.parse('2026-11-22T00:00:00Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      logged = sinon.stub(Logger.prototype, 'error');
      calls = 0;
      globalThis.fetch = async () => {
        calls += 1;
        if (failuresLeft > 0) { failuresLeft -= 1; throw new Error('ECONNREFUSED'); }
        return new Response('[{"user_id":"user-9"}]', { status: 200 });
      };
      denylist = new DenylistService(new ConfigService({
        IDENTITY_SERVICE_SECRET_GATEWAY: 'x'.repeat(32),
        IDENTITY_URL: 'http://127.0.0.1:3001',
      }));
    });

    afterEach(() => {
      denylist.onModuleDestroy();
      clock.restore();
      logged.restore();
    });

    it('retries every few seconds until the first load succeeds, then falls back to 30s', async () => {
      failuresLeft = 2;
      denylist.start();
      await clock.tickAsync(0);
      expect(calls).to.equal(1);
      expect(denylist.isFresh()).to.equal(false);

      await clock.tickAsync(DENYLIST_INITIAL_RETRY_MS);
      expect(calls).to.equal(2);
      expect(denylist.isFresh()).to.equal(false);

      await clock.tickAsync(DENYLIST_INITIAL_RETRY_MS);
      expect(calls).to.equal(3);
      expect(denylist.isFresh()).to.equal(true);
      expect(denylist.has('user-9')).to.equal(true);

      // หลังสำเร็จแล้วต้องไม่ยิงถี่อีก
      await clock.tickAsync(DENYLIST_REFRESH_INTERVAL_MS - 1);
      expect(calls).to.equal(3);
      await clock.tickAsync(1);
      expect(calls).to.equal(4);
      expect(logged.callCount).to.equal(2);
    });

    it('keeps the 30s cadence when a later refresh fails after the first success', async () => {
      failuresLeft = 0;
      denylist.start();
      await clock.tickAsync(0);
      expect(calls).to.equal(1);

      failuresLeft = 1;
      await clock.tickAsync(DENYLIST_REFRESH_INTERVAL_MS);
      expect(calls).to.equal(2);
      await clock.tickAsync(DENYLIST_INITIAL_RETRY_MS);
      expect(calls).to.equal(2);
      await clock.tickAsync(DENYLIST_REFRESH_INTERVAL_MS - DENYLIST_INITIAL_RETRY_MS);
      expect(calls).to.equal(3);
    });

    it('stops retrying after module destroy', async () => {
      failuresLeft = Number.POSITIVE_INFINITY;
      denylist.start();
      await clock.tickAsync(0);
      denylist.onModuleDestroy();
      await clock.tickAsync(DENYLIST_INITIAL_RETRY_MS * 5);
      expect(calls).to.equal(1);
    });

    it('ignores a second start() call', async () => {
      failuresLeft = 0;
      denylist.start();
      denylist.start();
      await clock.tickAsync(0);
      expect(calls).to.equal(1);
    });
  });

  it('logs and refuses startup when the Gateway service secret is missing or too short', () => {
    const logged = sinon.stub(Logger.prototype, 'error');
    try {
      for (const secret of ['', 'x'.repeat(31)]) {
        const denylist = new DenylistService(new ConfigService({
          IDENTITY_SERVICE_SECRET_GATEWAY: secret,
          IDENTITY_URL: 'http://127.0.0.1:3001',
        }));
        expect(() => denylist.start()).to.throw('IDENTITY_SERVICE_SECRET_GATEWAY must contain at least 32 characters');
        expect(denylist.isFresh()).to.equal(false);
      }
      expect(logged.callCount).to.equal(2);
      expect(logged.getCall(0).args[0]).to.include('IDENTITY_SERVICE_SECRET_GATEWAY');
      expect(logged.getCall(1).args[0]).to.include('IDENTITY_SERVICE_SECRET_GATEWAY');
    } finally { logged.restore(); }
  });
});
