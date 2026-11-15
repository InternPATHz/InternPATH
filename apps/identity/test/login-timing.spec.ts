import { expect } from 'chai';
import argon2 from 'argon2';
import sinon from 'sinon';
import type { ConfigService } from '@nestjs/config';
import { AppException } from '@internpath/common';
import { AuthService } from '../src/modules/auth/auth.service';
import type { AuthMailer } from '../src/modules/auth/auth.mailer';
import type { PrismaService } from '../src/prisma/prisma.service';

describe('login timing', function () {
  this.timeout(10_000);

  it('verifies a normal-cost Argon2id hash before rejecting an unknown email', async () => {
    const db = { user: { findUnique: async () => null } } as unknown as PrismaService;
    const auth = new AuthService(db, {} as ConfigService, {} as AuthMailer);
    const verify = sinon.spy(argon2, 'verify');

    try {
      let error: unknown;
      try { await auth.login('missing@example.com', 'wrong password'); }
      catch (cause) { error = cause; }

      expect(error).to.be.instanceOf(AppException);
      expect((error as AppException).code).to.equal('INVALID_CREDENTIALS');
      expect(verify.calledOnce).to.equal(true);
      expect(verify.firstCall.args[0]).to.match(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    } finally {
      verify.restore();
    }
  });
});
