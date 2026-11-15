import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { Client } from 'pg';
import { PrismaClient } from '../../generated/client';

const APP_ROOT = path.resolve(__dirname, '../..');
const TEST_NAME = /^job_it_[0-9a-f]{16}$/;

/** Explicit opt-in only. Never fall back to an application's database URL. */
export function validateAdminUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('JOB_IT_ADMIN_URL must be a local PostgreSQL maintenance URL (value hidden)');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
    url.pathname !== '/postgres' ||
    !url.username ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      'JOB_IT_ADMIN_URL must use loopback, /postgres, a user, and no query or fragment',
    );
  }
  return url.toString();
}

export function validateTestTarget(adminUrl: string, targetUrl: string, name: string): void {
  const expected = new URL(validateAdminUrl(adminUrl));
  if (!TEST_NAME.test(name))
    throw new Error('Refusing a database without a generated job_it_ name');
  expected.pathname = `/${name}`;
  if (targetUrl !== expected.toString())
    throw new Error('Refusing a mismatched test database target');
}

function databaseError(action: string, error: unknown): Error {
  const code = (error as { code?: string }).code;
  // Do not expose pg connection strings, child-process arguments, or server error details.
  return new Error(`${action} failed${code && /^[A-Z0-9_]+$/.test(code) ? ` (${code})` : ''}`);
}

/** Missing/unavailable infrastructure is pending; unsafe URLs and auth failures fail loudly. */
export async function dbReachableOrSkip(ctx: Mocha.Context): Promise<void> {
  if (!process.env.JOB_IT_ADMIN_URL) {
    console.warn('Job DB tests pending: set JOB_IT_ADMIN_URL to a local /postgres test-admin URL.');
    ctx.skip();
  }
  const url = validateAdminUrl(process.env.JOB_IT_ADMIN_URL!);
  const client = new Client({ connectionString: url, connectionTimeoutMillis: 2000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    const result = await client.query('SELECT current_database() AS name');
    if (result.rows[0].name !== 'postgres') throw new Error('Unexpected maintenance database');
  } catch (error) {
    if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH'].includes((error as { code: string }).code)) {
      console.warn('Job DB tests pending: local PostgreSQL is unavailable.');
      ctx.skip();
    }
    throw databaseError('Job test-admin connection', error);
  } finally {
    await client.end();
  }
}

export interface TestDatabase {
  name: string;
  url: string;
  prisma: PrismaClient;
  deployMigrations(): void;
  drop(): Promise<void>;
}

/** Only the closure that successfully created this database can migrate or drop it. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const adminUrl = validateAdminUrl(process.env.JOB_IT_ADMIN_URL ?? '');
  const name = `job_it_${randomBytes(8).toString('hex')}`;
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  validateTestTarget(adminUrl, url, name);
  let owned = false;
  let prisma: PrismaClient | undefined;

  const withAdmin = async (action: (client: Client) => Promise<void>): Promise<void> => {
    validateAdminUrl(adminUrl);
    validateTestTarget(adminUrl, url, name);
    const admin = new Client({ connectionString: adminUrl, connectionTimeoutMillis: 2000 });
    admin.on('error', () => undefined);
    try {
      await admin.connect();
      const result = await admin.query('SELECT current_database() AS name');
      if (result.rows[0].name !== 'postgres') throw new Error('Unexpected maintenance database');
      await action(admin);
    } catch (error) {
      throw databaseError('Job disposable database administration', error);
    } finally {
      await admin.end();
    }
  };

  const drop = async (): Promise<void> => {
    if (!owned) return;
    try {
      await prisma?.$disconnect();
    } finally {
      await withAdmin(async (admin) => {
        // name has a strict generated-name allow-list; never supplied by callers.
        await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        owned = false;
      });
    }
  };

  const deployMigrations = (): void => {
    validateTestTarget(adminUrl, url, name);
    if (!owned) throw new Error('Refusing to migrate a database not owned by this test run');
    try {
      execFileSync(
        process.execPath,
        [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'],
        {
          cwd: APP_ROOT,
          env: { ...process.env, JOB_DATABASE_URL: url, JOB_DIRECT_URL: url },
          stdio: 'pipe',
          timeout: 30000,
        },
      );
    } catch {
      throw new Error('Job test migration deploy failed (connection details hidden)');
    }
  };

  try {
    await withAdmin(async (admin) => {
      await admin.query(`CREATE DATABASE "${name}"`);
      owned = true;
    });
    deployMigrations();
    prisma = new PrismaClient({ datasourceUrl: url });
    await prisma.$connect();
    return { name, url, prisma, deployMigrations, drop };
  } catch (error) {
    await drop();
    // Original Prisma errors can contain connection information.
    throw databaseError('Job disposable database setup', error);
  }
}
