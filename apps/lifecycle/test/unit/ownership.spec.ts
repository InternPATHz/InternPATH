import { JwtClaims } from '@internpath/common';
import { expect } from 'chai';
import {
  assertAdvisorOwnership,
  assertCompanyOwnership,
  assertStudentOwnership,
} from '../../src/common/auth/ownership';

describe('Ownership Checks (Unit)', () => {
  const studentUser: JwtClaims = {
    sub: 'student-uuid-1',
    role: 'STUDENT',
    jti: 'jti-1',
    iat: 1000,
    exp: 2000,
  };

  const hrUser: JwtClaims = {
    sub: 'hr-uuid-1',
    role: 'COMPANY_HR',
    company_id: 'corp-uuid-1',
    jti: 'jti-2',
    iat: 1000,
    exp: 2000,
  };

  const advisorUser: JwtClaims = {
    sub: 'advisor-uuid-1',
    role: 'ADVISOR',
    jti: 'jti-3',
    iat: 1000,
    exp: 2000,
  };

  const adminUser: JwtClaims = {
    sub: 'admin-uuid-1',
    role: 'PLATFORM_ADMIN',
    jti: 'jti-4',
    iat: 1000,
    exp: 2000,
  };

  describe('assertStudentOwnership', () => {
    it('ผ่านเมื่อเป็นเจ้าของข้อมูล', () => {
      expect(() => assertStudentOwnership(studentUser, 'student-uuid-1')).to.not.throw();
    });

    it('ผ่านเสมอเมื่อเป็น PLATFORM_ADMIN', () => {
      expect(() => assertStudentOwnership(adminUser, 'other-student-uuid')).to.not.throw();
    });

    it('โยน 403 NOT_OWNER_OF_RESOURCE เมื่อ sub ไม่ตรงกับ target', () => {
      expect(() => assertStudentOwnership(studentUser, 'other-student-uuid'))
        .to.throw()
        .with.property('code', 'NOT_OWNER_OF_RESOURCE');
    });
  });

  describe('assertCompanyOwnership', () => {
    it('ผ่านเมื่อ company_id ตรงกับเป้าหมาย', () => {
      expect(() => assertCompanyOwnership(hrUser, 'corp-uuid-1')).to.not.throw();
    });

    it('ผ่านเสมอเมื่อเป็น PLATFORM_ADMIN', () => {
      expect(() => assertCompanyOwnership(adminUser, 'other-corp-uuid')).to.not.throw();
    });

    it('โยน 403 NOT_OWNER_OF_RESOURCE เมื่อ company_id ไม่ตรง', () => {
      expect(() => assertCompanyOwnership(hrUser, 'other-corp-uuid'))
        .to.throw()
        .with.property('code', 'NOT_OWNER_OF_RESOURCE');
    });

    it('โยน 403 NOT_OWNER_OF_RESOURCE เมื่อผู้ใช้ไม่มี company_id', () => {
      expect(() => assertCompanyOwnership(studentUser, 'corp-uuid-1'))
        .to.throw()
        .with.property('code', 'NOT_OWNER_OF_RESOURCE');
    });
  });

  describe('assertAdvisorOwnership', () => {
    it('ผ่านเมื่อ sub ตรงกับ advisor_user_id', () => {
      expect(() => assertAdvisorOwnership(advisorUser, 'advisor-uuid-1')).to.not.throw();
    });

    it('ผ่านเสมอเมื่อเป็น PLATFORM_ADMIN', () => {
      expect(() => assertAdvisorOwnership(adminUser, 'other-advisor-uuid')).to.not.throw();
    });

    it('โยน 403 NOT_OWNER_OF_RESOURCE เมื่อ advisor_user_id ไม่ตรงหรือไม่มี', () => {
      expect(() => assertAdvisorOwnership(advisorUser, 'other-advisor-uuid'))
        .to.throw()
        .with.property('code', 'NOT_OWNER_OF_RESOURCE');
      expect(() => assertAdvisorOwnership(advisorUser, null))
        .to.throw()
        .with.property('code', 'NOT_OWNER_OF_RESOURCE');
    });
  });
});
