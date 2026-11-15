import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { expect } from 'chai';
import { Client } from 'pg';
import { Prisma } from '../../generated/client';
import {
  createTestDatabase,
  dbReachableOrSkip,
  validateTestTarget,
  type TestDatabase,
} from '../support/db';

// Explicit contract expectations, independent of Prisma's runtime metadata.
const COLUMNS: Record<string, string[]> = {
  jobs: [
    'id',
    'company_id',
    'created_by',
    'category',
    'job_title',
    'description',
    'responsibilities',
    'qualifications',
    'allowance_type',
    'allowance_amount_thb',
    'allowance_text',
    'location',
    'contact_notes',
    'work_mode',
    'hours_per_week',
    'internship_period_start',
    'internship_period_end',
    'target_majors',
    'quota',
    'quota_reserved',
    'quota_confirmed',
    'status',
    'suspended_from_status',
    'featured',
    'current_submission_id',
    'verifying_since',
    'published_at',
    'closed_at',
    'application_deadline',
    'entity_version',
    'version',
    'created_at',
    'updated_at',
  ],
  job_submissions: [
    'id',
    'job_id',
    'kind',
    'changed_fields',
    'submitted_by',
    'submitted_at',
    'result_decision',
    'resolved_at',
    'created_at',
    'updated_at',
  ],
  quota_reservations: [
    'application_id',
    'job_id',
    'status',
    'reserved_at',
    'confirmed_at',
    'released_at',
    'release_reason',
    'created_at',
    'updated_at',
  ],
  company_snapshots: [
    'company_id',
    'name',
    'logo_key',
    'status',
    'university_partner',
    'verified_badge',
    'entity_version',
    'created_at',
    'updated_at',
  ],
  company_entitlements: [
    'company_id',
    'featured_enabled',
    'fast_track_enabled',
    'entity_version',
    'created_at',
    'updated_at',
  ],
  company_flags: ['company_id', 'under_review', 'entity_version', 'created_at', 'updated_at'],
  outbox_events: [
    'id',
    'type',
    'version',
    'aggregate_id',
    'payload',
    'correlation_id',
    'created_at',
    'published_at',
    'attempts',
  ],
  processed_events: ['event_id', 'consumer', 'processed_at'],
  status_history: [
    'id',
    'entity',
    'entity_id',
    'from_status',
    'to_status',
    'actor_id',
    'actor_role',
    'reason',
    'correlation_id',
    'occurred_at',
  ],
};

const ENUMS: Record<string, string[]> = {
  job_status: [
    'DRAFT',
    'VERIFYING',
    'PUBLISHED',
    'PENDING_REVIEW',
    'AUTO_REJECTED',
    'ADMIN_REJECTED',
    'SUSPENDED',
    'REMOVED',
    'CLOSED',
  ],
  work_mode: ['ONSITE', 'REMOTE', 'HYBRID'],
  job_category: ['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES'],
  quota_reservation_status: ['RESERVED', 'CONFIRMED', 'RELEASED'],
  company_status: ['PENDING', 'NEED_MORE_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED'],
  allowance_type: ['AMOUNT', 'NONE'],
  job_submission_kind: ['NEW', 'EDIT', 'RESUBMIT'],
};

const REQUIRED = [
  'category',
  'job_title',
  'description',
  'responsibilities',
  'qualifications',
  'location',
  'work_mode',
  'hours_per_week',
  'allowance_type',
  'internship_period_start',
  'internship_period_end',
  'target_majors',
  'quota',
  'application_deadline',
];

describe('Job initial migration (disposable PostgreSQL database)', function () {
  this.timeout(60000);
  let db: TestDatabase | undefined;
  let pg: Client;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    pg = new Client({ connectionString: db.url });
    pg.on('error', () => undefined);
    await pg.connect();
    expect((await pg.query('SELECT current_database() AS name')).rows[0].name).to.equal(db.name);
  });

  after(async () => {
    try {
      await pg?.end();
    } finally {
      await db?.drop();
    }
  });

  const insertJob = async (overrides: Record<string, unknown> = {}) => {
    const data = {
      id: randomUUID(),
      company_id: randomUUID(),
      created_by: randomUUID(),
      status: 'VERIFYING',
      entity_version: 0,
      version: 1,
      category: 'TECH_IT',
      job_title: 'Software internship',
      description: 'Internship description',
      responsibilities: 'Build software',
      qualifications: 'Student',
      location: 'Bangkok',
      work_mode: 'ONSITE',
      hours_per_week: 40,
      allowance_type: 'NONE',
      internship_period_start: '2027-01-01',
      internship_period_end: '2027-04-01',
      target_majors: ['Computer Science'],
      quota: 3,
      application_deadline: '2026-12-01',
      ...overrides,
    };
    const keys = Object.keys(data);
    const result = await pg.query(
      `INSERT INTO jobs (${keys.map((k) => `"${k}"`).join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      Object.values(data),
    );
    return result.rows[0];
  };

  const fails = async (run: () => Promise<unknown>, code: string, constraint?: string) => {
    let actual: { code?: string; constraint?: string } = {};
    try {
      await run();
    } catch (error) {
      actual = error as typeof actual;
    }
    expect(actual.code, 'PostgreSQL SQLSTATE').to.equal(code);
    if (constraint) expect(actual.constraint).to.equal(constraint);
  };

  const columns = async () =>
    (
      await pg.query(
        `SELECT table_name, column_name, udt_name, is_nullable, column_default, datetime_precision
     FROM information_schema.columns WHERE table_schema = 'public'
     AND table_name <> '_prisma_migrations' ORDER BY table_name, ordinal_position`,
      )
    ).rows;

  it('applies to an empty database and creates exactly the nine approved tables', async () => {
    const tables = (
      await pg.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'
       AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
      )
    ).rows.map((r) => r.table_name);
    expect(tables).to.deep.equal(Object.keys(COLUMNS).sort());
    const migrations = (
      await pg.query('SELECT migration_name, finished_at FROM _prisma_migrations')
    ).rows;
    expect(migrations).to.have.length(1);
    expect(migrations[0].migration_name).to.equal('20261115214500_init_job');
    expect(migrations[0].finished_at).to.be.instanceOf(Date);
  });

  it('has every approved column, with no extra application tables or columns', async () => {
    const rows = await columns();
    for (const [table, expected] of Object.entries(COLUMNS)) {
      expect(
        rows.filter((r) => r.table_name === table).map((r) => r.column_name),
        table,
      ).to.deep.equal(expected);
    }
  });

  it('preserves UUID, timestamptz(6), date-only, array, JSONB, and mapped enum types', async () => {
    const rows = await columns();
    const uuids: Record<string, string[]> = {
      jobs: ['id', 'company_id', 'created_by', 'current_submission_id'],
      job_submissions: ['id', 'job_id', 'submitted_by'],
      quota_reservations: ['application_id', 'job_id'],
      company_snapshots: ['company_id'],
      company_entitlements: ['company_id'],
      company_flags: ['company_id'],
      outbox_events: ['id', 'aggregate_id', 'correlation_id'],
      processed_events: ['event_id'],
      status_history: ['id', 'entity_id', 'actor_id', 'correlation_id'],
    };
    for (const [table, names] of Object.entries(uuids)) {
      for (const name of names)
        expect(
          rows.find((r) => r.table_name === table && r.column_name === name)?.udt_name,
        ).to.equal('uuid');
    }
    for (const row of rows.filter(
      (r) => /_at$/.test(r.column_name) || r.column_name === 'verifying_since',
    )) {
      expect(row.udt_name).to.equal('timestamptz');
      expect(row.datetime_precision).to.equal(6);
    }
    for (const name of [
      'internship_period_start',
      'internship_period_end',
      'application_deadline',
    ]) {
      expect(
        rows.find((r) => r.table_name === 'jobs' && r.column_name === name)?.udt_name,
      ).to.equal('date');
    }
    for (const [table, name, type] of [
      ['jobs', 'target_majors', '_text'],
      ['job_submissions', 'changed_fields', '_text'],
      ['outbox_events', 'payload', 'jsonb'],
      ['jobs', 'status', 'job_status'],
      ['jobs', 'suspended_from_status', 'job_status'],
      ['jobs', 'category', 'job_category'],
      ['jobs', 'work_mode', 'work_mode'],
      ['jobs', 'allowance_type', 'allowance_type'],
      ['job_submissions', 'kind', 'job_submission_kind'],
      ['quota_reservations', 'status', 'quota_reservation_status'],
      ['company_snapshots', 'status', 'company_status'],
    ])
      expect(rows.find((r) => r.table_name === table && r.column_name === name)?.udt_name).to.equal(
        type,
      );
    for (const name of ['application_id', 'job_id', 'status', 'reserved_at']) {
      expect(
        rows.find((r) => r.table_name === 'quota_reservations' && r.column_name === name)
          ?.is_nullable,
      ).to.equal('NO');
    }
    for (const name of ['confirmed_at', 'released_at', 'release_reason']) {
      expect(
        rows.find((r) => r.table_name === 'quota_reservations' && r.column_name === name)
          ?.is_nullable,
      ).to.equal('YES');
    }
  });

  it('creates exactly the approved enum values and mappings', async () => {
    const rows = (
      await pg.query(
        `SELECT t.typname AS name, array_agg(e.enumlabel::text ORDER BY e.enumsortorder) AS values
       FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid
       JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'public' GROUP BY t.typname`,
      )
    ).rows;
    expect(Object.fromEntries(rows.map((r) => [r.name, r.values]))).to.deep.equal(ENUMS);
  });

  it('preserves indexes including pending outbox partial index, without search extensions', async () => {
    const indexes = (
      await pg.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public'")
    ).rows;
    const index = (name: string) => indexes.find((r) => r.indexname === name)?.indexdef as string;
    expect(index('jobs_status_featured_published_at_idx')).to.include(
      '(status, featured DESC, published_at DESC)',
    );
    expect(index('jobs_target_majors_idx')).to.include('USING gin (target_majors)');
    expect(index('status_history_entity_entity_id_occurred_at_idx')).to.include(
      '(entity, entity_id, occurred_at)',
    );
    expect(index('outbox_events_published_at_created_at_idx')).to.include(
      '(published_at, created_at)',
    );
    expect(index('outbox_events_pending_created_at_idx')).to.include(
      '(created_at) WHERE (published_at IS NULL)',
    );
    expect(index('processed_events_pkey')).to.include('UNIQUE').and.include('(event_id, consumer)');
    expect(index('quota_reservations_pkey')).to.include('UNIQUE').and.include('(application_id)');
    expect(indexes.some((r) => /trgm|tsvector/.test(r.indexdef))).to.equal(false);
    expect(
      (await pg.query("SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'")).rowCount,
    ).to.equal(0);
  });

  it('has exactly the two local Job foreign keys and no cross-service foreign keys', async () => {
    const keys = (
      await pg.query(
        `SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint
       WHERE contype = 'f' AND connamespace = 'public'::regnamespace ORDER BY conname`,
      )
    ).rows;
    expect(keys.map((r) => r.conname)).to.deep.equal([
      'job_submissions_job_id_fkey',
      'quota_reservations_job_id_fkey',
    ]);
    for (const row of keys)
      expect(row.definition).to.equal(
        'FOREIGN KEY (job_id) REFERENCES jobs(id) ON UPDATE CASCADE ON DELETE RESTRICT',
      );
  });

  it('allows incomplete DRAFTs through the isolated Prisma client, with documented defaults', async () => {
    const job = await db!.prisma.job.create({
      data: {
        companyId: randomUUID(),
        createdBy: randomUUID(),
        status: 'DRAFT',
        version: 1,
        entityVersion: 0,
      },
    });
    const stored = (await pg.query('SELECT * FROM jobs WHERE id = $1', [job.id])).rows[0];
    expect(stored.target_majors).to.equal(null);
    expect(job.targetMajors).to.deep.equal([]); // Prisma normalizes SQL NULL arrays on read.
    expect(stored.quota).to.equal(null);
    expect(job.quotaReserved).to.equal(0);
    expect(job.quotaConfirmed).to.equal(0);
    expect(job.featured).to.equal(false);
    expect(job.createdAt).to.be.instanceOf(Date);
    expect(job.updatedAt).to.be.instanceOf(Date);
    expect(job.id).to.match(/^[0-9a-f-]{36}$/);
  });

  describe('target_majors Prisma compatibility', () => {
    const assertPrismaReads = async (id: string, majors: string[]) => {
      const unique = await db!.prisma.job.findUnique({ where: { id } });
      expect(unique?.id).to.equal(id);
      expect(unique?.targetMajors).to.deep.equal(majors);
      const many = await db!.prisma.job.findMany({ where: { id } });
      expect(many).to.have.length(1);
      expect(many[0].targetMajors).to.deep.equal(majors);
    };

    const readableCases: Array<{ status: string; majors: string[] | null; label: string }> = [
      { status: 'DRAFT', majors: null, label: 'SQL NULL' },
      { status: 'DRAFT', majors: [], label: 'empty array' },
      { status: 'DRAFT', majors: ['CS'], label: 'nonempty array' },
      { status: 'PUBLISHED', majors: ['CS'], label: 'nonempty array' },
    ];
    for (const { status, majors, label } of readableCases) {
      it(`keeps ${status} with ${label} readable after INSERT and UPDATE`, async () => {
        // Exercise genuinely incomplete DRAFTs, rather than otherwise complete fixtures.
        const content =
          status === 'DRAFT' ? Object.fromEntries(REQUIRED.map((field) => [field, null])) : {};
        const inserted = await insertJob({ ...content, status, target_majors: majors });
        await assertPrismaReads(inserted.id, majors ?? []);
        const updated = await insertJob({ ...content, status, target_majors: ['Original major'] });
        await pg.query('UPDATE jobs SET target_majors = $1::text[] WHERE id = $2', [
          majors,
          updated.id,
        ]);
        await assertPrismaReads(updated.id, majors ?? []);
        // Reads normalize a whole NULL array to [] in Prisma without changing SQL storage.
        for (const id of [inserted.id, updated.id]) {
          expect(
            (await pg.query('SELECT target_majors FROM jobs WHERE id = $1', [id])).rows[0]
              .target_majors,
          ).to.deep.equal(majors);
        }
      });
    }

    for (const status of ENUMS.job_status) {
      it(`rejects NULL elements on ${status} INSERT and UPDATE`, async () => {
        const job = await insertJob({ status, target_majors: ['Original major'] });
        for (const majors of [[null], ['CS', null]]) {
          await fails(
            () => insertJob({ status, target_majors: majors }),
            '23514',
            'jobs_target_majors_no_null_elements_check',
          );
          await fails(
            () =>
              pg.query('UPDATE jobs SET target_majors = $1::text[] WHERE id = $2', [
                majors,
                job.id,
              ]),
            '23514',
            'jobs_target_majors_no_null_elements_check',
          );
          await assertPrismaReads(job.id, ['Original major']);
        }
      });
    }

    for (const status of ['VERIFYING', 'PUBLISHED']) {
      for (const majors of [null, []]) {
        it(`preserves completeness when updating ${status} to ${majors === null ? 'SQL NULL' : 'empty majors'}`, async () => {
          const job = await insertJob({ status });
          await fails(
            () =>
              pg.query('UPDATE jobs SET target_majors = $1::text[] WHERE id = $2', [
                majors,
                job.id,
              ]),
            '23514',
            'jobs_non_draft_complete_check',
          );
          await assertPrismaReads(job.id, ['Computer Science']);
        });
      }
    }

    it('introduces no Prisma-representable drift from the handwritten array CHECK', () => {
      validateTestTarget(process.env.JOB_IT_ADMIN_URL!, db!.url, db!.name);
      try {
        // --exit-code returns 2 on drift. Both datasource URLs point only to our test DB.
        execFileSync(
          process.execPath,
          [
            require.resolve('prisma/build/index.js'),
            'migrate',
            'diff',
            '--from-schema-datasource',
            'prisma/schema.prisma',
            '--to-schema-datamodel',
            'prisma/schema.prisma',
            '--exit-code',
          ],
          {
            cwd: path.resolve(__dirname, '../..'),
            env: { ...process.env, JOB_DATABASE_URL: db!.url, JOB_DIRECT_URL: db!.url },
            stdio: 'pipe',
            timeout: 30000,
          },
        );
      } catch {
        throw new Error('Job test schema-drift check failed (connection details hidden)');
      }
    });
  });

  it('allows unfinished AMOUNT content on DRAFT and optional notes/text on submitted jobs', async () => {
    await insertJob({
      status: 'DRAFT',
      allowance_type: 'AMOUNT',
      allowance_amount_thb: null,
      target_majors: null,
      quota: null,
    });
    const job = await insertJob({ allowance_text: null, contact_notes: null });
    expect(job.allowance_text).to.equal(null);
    expect(job.contact_notes).to.equal(null);
  });

  it('accepts complete content for every non-DRAFT status, without extra business validation', async () => {
    for (const status of ENUMS.job_status.filter((s) => s !== 'DRAFT')) {
      await insertJob({ status, job_title: '', hours_per_week: 0 });
    }
  });

  for (const status of ['VERIFYING', 'PUBLISHED']) {
    it(`rejects a wholly incomplete ${status} insert`, async () => {
      await fails(
        () =>
          pg.query(
            'INSERT INTO jobs (company_id, created_by, status, version, entity_version) VALUES ($1, $2, $3, 1, 0)',
            [randomUUID(), randomUUID(), status],
          ),
        '23514',
        'jobs_non_draft_complete_check',
      );
    });
    for (const name of REQUIRED) {
      it(`rejects NULL ${name} on ${status}, without a SQL UNKNOWN bypass`, async () => {
        await fails(
          () => insertJob({ status, [name]: null }),
          '23514',
          'jobs_non_draft_complete_check',
        );
      });
    }
    it(`rejects empty target_majors on ${status}`, async () => {
      await fails(
        () => insertJob({ status, target_majors: [] }),
        '23514',
        'jobs_non_draft_complete_check',
      );
    });
  }

  it('prevents promoting an incomplete DRAFT through an UPDATE', async () => {
    const job = await db!.prisma.job.create({
      data: {
        companyId: randomUUID(),
        createdBy: randomUUID(),
        status: 'DRAFT',
        version: 1,
        entityVersion: 0,
      },
    });
    await fails(
      () => pg.query("UPDATE jobs SET status = 'VERIFYING' WHERE id = $1", [job.id]),
      '23514',
    );
    expect((await db!.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status).to.equal(
      'DRAFT',
    );
  });

  for (const amount of [null, 0, -1]) {
    it(`rejects AMOUNT allowance with ${amount} on a submitted job`, async () => {
      await fails(
        () => insertJob({ allowance_type: 'AMOUNT', allowance_amount_thb: amount }),
        '23514',
      );
    });
  }
  it('accepts positive AMOUNT allowances and NONE without an amount', async () => {
    await insertJob({ allowance_type: 'AMOUNT', allowance_amount_thb: 1 });
    await insertJob({ allowance_type: 'NONE', allowance_amount_thb: null });
  });

  for (const quota of [0, -1]) {
    it(`rejects non-DRAFT quota ${quota}`, async () => {
      await fails(() => insertJob({ quota }), '23514');
    });
  }
  for (const name of ['quota_reserved', 'quota_confirmed']) {
    it(`rejects negative ${name} even on DRAFT`, async () => {
      await fails(
        () => insertJob({ status: 'DRAFT', quota: null, [name]: -1 }),
        '23514',
        `jobs_${name}_nonnegative_check`,
      );
    });
    it(`rejects NULL ${name} when quota is set`, async () => {
      await fails(() => insertJob({ [name]: null }), '23514', 'jobs_quota_capacity_check');
    });
  }
  it('allows NULL counters only while DRAFT quota is unset, preserving Phase 1A nullability', async () => {
    await insertJob({ status: 'DRAFT', quota: null, quota_reserved: null, quota_confirmed: null });
  });
  it('accepts exact capacity and rejects excess capacity, counter overflow, or lowering quota below commitments', async () => {
    const job = await insertJob({ quota: 3, quota_reserved: 1, quota_confirmed: 2 });
    await fails(
      () => insertJob({ quota: 3, quota_reserved: 2, quota_confirmed: 2 }),
      '23514',
      'jobs_quota_capacity_check',
    );
    await fails(
      () => insertJob({ quota: 2147483647, quota_reserved: 2147483647, quota_confirmed: 1 }),
      '23514',
      'jobs_quota_capacity_check',
    );
    await fails(
      () => pg.query('UPDATE jobs SET quota = 2 WHERE id = $1', [job.id]),
      '23514',
      'jobs_quota_capacity_check',
    );
  });

  it('keeps application_id primary, reserved_at required, and confirmation/release fields optional', async () => {
    const job = await insertJob();
    const application = randomUUID();
    const reserve = (reservedAt: Date | null = new Date('2026-11-15T00:00:00Z')) =>
      pg.query(
        "INSERT INTO quota_reservations (application_id, job_id, status, reserved_at) VALUES ($1, $2, 'RESERVED', $3) RETURNING *",
        [application, job.id, reservedAt],
      );
    await fails(() => reserve(null), '23502');
    const row = (await reserve()).rows[0];
    expect(row.confirmed_at).to.equal(null);
    expect(row.released_at).to.equal(null);
    expect(row.release_reason).to.equal(null);
    await fails(() => reserve(), '23505', 'quota_reservations_pkey');
  });

  it('rejects invalid local foreign keys for both submissions and reservations', async () => {
    await fails(
      () =>
        pg.query(
          "INSERT INTO job_submissions (job_id, kind, submitted_by, submitted_at) VALUES ($1, 'NEW', $2, now())",
          [randomUUID(), randomUUID()],
        ),
      '23503',
      'job_submissions_job_id_fkey',
    );
    await fails(
      () =>
        pg.query(
          "INSERT INTO quota_reservations (application_id, job_id, status, reserved_at) VALUES ($1, $2, 'RESERVED', now())",
          [randomUUID(), randomUUID()],
        ),
      '23503',
      'quota_reservations_job_id_fkey',
    );
  });

  const seedHistory = async (actor: string | null = randomUUID()) =>
    (
      await pg.query(
        `INSERT INTO status_history (entity, entity_id, from_status, to_status, actor_id, actor_role, reason, correlation_id)
     VALUES ('JOB', $1, 'DRAFT', 'VERIFYING', $2, 'COMPANY_HR', 'Submitted', $3) RETURNING *`,
        [randomUUID(), actor, randomUUID()],
      )
    ).rows[0];

  const historyAttempt = async (
    sql: string,
    params: unknown[],
    settings: Record<string, string> = {},
  ) => {
    await pg.query('BEGIN');
    try {
      for (const [name, value] of Object.entries(settings))
        await pg.query('SELECT set_config($1, $2, true)', [name, value]);
      await pg.query(sql, params);
      return '';
    } catch (error) {
      return (error as { code?: string }).code;
    } finally {
      await pg.query('ROLLBACK');
    }
  };

  it('rejects ordinary history UPDATE (including no-op) and DELETE', async () => {
    const row = await seedHistory();
    await fails(
      () => pg.query("UPDATE status_history SET to_status = 'PUBLISHED' WHERE id = $1", [row.id]),
      'P0001',
    );
    await fails(
      () => pg.query('UPDATE status_history SET actor_id = actor_id WHERE id = $1', [row.id]),
      'P0001',
    );
    await fails(() => pg.query('DELETE FROM status_history WHERE id = $1', [row.id]), 'P0001');
  });

  it('commits authorized actor-only anonymization, preserving every other column and expiring local settings', async () => {
    const row = await seedHistory();
    const anonymous = randomUUID();
    await pg.query('BEGIN');
    try {
      await pg.query(
        "SELECT set_config('internpath.anonymize', 'on', true), set_config('internpath.anonymous_actor_id', $1, true)",
        [anonymous],
      );
      await pg.query('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, row.id]);
      await pg.query('COMMIT');
    } catch (error) {
      await pg.query('ROLLBACK');
      throw error;
    }
    expect(
      (await pg.query('SELECT * FROM status_history WHERE id = $1', [row.id])).rows[0],
    ).to.deep.equal({ ...row, actor_id: anonymous });
    const settings = (
      await pg.query(
        "SELECT current_setting('internpath.anonymize', true) AS mode, current_setting('internpath.anonymous_actor_id', true) AS actor",
      )
    ).rows[0];
    expect(settings.mode || '').to.equal('');
    expect(settings.actor || '').to.equal('');
    await fails(
      () =>
        pg.query('UPDATE status_history SET actor_id = $1 WHERE id = $2', [randomUUID(), row.id]),
      'P0001',
    );
  });

  for (const mode of ['neither', 'anonymize only', 'actor only', 'off', 'empty actor']) {
    it(`rejects anonymization with ${mode} settings`, async () => {
      const row = await seedHistory();
      const anonymous = randomUUID();
      const settings: Record<string, string> = {};
      if (mode !== 'neither' && mode !== 'actor only')
        settings['internpath.anonymize'] = mode === 'off' ? 'off' : 'on';
      if (mode !== 'neither' && mode !== 'anonymize only')
        settings['internpath.anonymous_actor_id'] = mode === 'empty actor' ? '' : anonymous;
      expect(
        await historyAttempt(
          'UPDATE status_history SET actor_id = $1 WHERE id = $2',
          [anonymous, row.id],
          settings,
        ),
      ).to.equal('P0001');
    });
  }

  it('rejects mismatched or NULL actor IDs, SYSTEM rows, no-op anonymization, and DELETE even with both settings', async () => {
    const row = await seedHistory();
    const system = await seedHistory(null);
    const anonymous = randomUUID();
    const both = { 'internpath.anonymize': 'on', 'internpath.anonymous_actor_id': anonymous };
    for (const [id, actor] of [
      [row.id, randomUUID()],
      [row.id, null],
      [system.id, anonymous],
    ]) {
      expect(
        await historyAttempt(
          'UPDATE status_history SET actor_id = $1 WHERE id = $2',
          [actor, id],
          both,
        ),
      ).to.equal('P0001');
    }
    expect(
      await historyAttempt(
        'UPDATE status_history SET actor_id = $1 WHERE id = $2',
        [row.actor_id, row.id],
        { ...both, 'internpath.anonymous_actor_id': row.actor_id },
      ),
    ).to.equal('P0001');
    expect(
      await historyAttempt('DELETE FROM status_history WHERE id = $1', [row.id], both),
    ).to.equal('P0001');
  });

  it('rejects changes to every other history column during authorized anonymization', async () => {
    const row = await seedHistory();
    const anonymous = randomUUID();
    const both = { 'internpath.anonymize': 'on', 'internpath.anonymous_actor_id': anonymous };
    const changes: Record<string, unknown> = {
      id: randomUUID(),
      entity: 'OTHER',
      entity_id: randomUUID(),
      from_status: null,
      to_status: 'PUBLISHED',
      actor_role: 'SYSTEM',
      reason: null,
      correlation_id: randomUUID(),
      occurred_at: new Date('2000-01-01T00:00:00Z'),
    };
    for (const [column, value] of Object.entries(changes)) {
      expect(
        await historyAttempt(
          `UPDATE status_history SET actor_id = $1, "${column}" = $2 WHERE id = $3`,
          [anonymous, value, row.id],
          both,
        ),
        column,
      ).to.equal('P0001');
    }
  });

  it('rolls back a valid anonymization together with another write on transaction failure', async () => {
    const row = await seedHistory();
    const anonymous = randomUUID();
    const event = randomUUID();
    await pg.query('BEGIN');
    try {
      await pg.query(
        "SELECT set_config('internpath.anonymize', 'on', true), set_config('internpath.anonymous_actor_id', $1, true)",
        [anonymous],
      );
      await pg.query('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, row.id]);
      await pg.query("INSERT INTO processed_events (event_id, consumer) VALUES ($1, 'rollback')", [
        event,
      ]);
      await fails(
        () => pg.query("UPDATE status_history SET reason = 'forbidden' WHERE id = $1", [row.id]),
        'P0001',
      );
    } finally {
      await pg.query('ROLLBACK');
    }
    expect(
      (await pg.query('SELECT * FROM status_history WHERE id = $1', [row.id])).rows[0],
    ).to.deep.equal(row);
    expect(
      (await pg.query('SELECT 1 FROM processed_events WHERE event_id = $1', [event])).rowCount,
    ).to.equal(0);
  });

  it('rolls back Job, submission, reservation, history, outbox, and processed writes through the isolated Prisma client', async () => {
    const id = randomUUID();
    const application = randomUUID();
    const event = randomUUID();
    const marker = new Error('intentional rollback');
    let caught: unknown;
    try {
      await db!.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await tx.job.create({
          data: {
            id,
            companyId: randomUUID(),
            createdBy: randomUUID(),
            status: 'DRAFT',
            version: 1,
            entityVersion: 0,
          },
        });
        await tx.jobSubmission.create({
          data: {
            jobId: id,
            kind: 'NEW',
            submittedBy: randomUUID(),
            submittedAt: new Date('2026-11-15T00:00:00Z'),
          },
        });
        await tx.quotaReservation.create({
          data: {
            applicationId: application,
            jobId: id,
            status: 'RESERVED',
            reservedAt: new Date('2026-11-15T00:00:00Z'),
          },
        });
        await tx.statusHistory.create({
          data: {
            entity: 'JOB',
            entityId: id,
            toStatus: 'DRAFT',
            actorRole: 'SYSTEM',
            correlationId: event,
          },
        });
        await tx.outboxEvent.create({
          data: {
            id: event,
            type: 'JobStatusChanged',
            aggregateId: id,
            correlationId: event,
            payload: {},
          },
        });
        await tx.processedEvent.create({ data: { eventId: event, consumer: 'rollback' } });
        throw marker;
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).to.equal(marker);
    expect(await db!.prisma.job.count({ where: { id } })).to.equal(0);
    expect(await db!.prisma.jobSubmission.count({ where: { jobId: id } })).to.equal(0);
    expect(
      await db!.prisma.quotaReservation.count({ where: { applicationId: application } }),
    ).to.equal(0);
    expect(await db!.prisma.statusHistory.count({ where: { entityId: id } })).to.equal(0);
    expect(await db!.prisma.outboxEvent.count({ where: { id: event } })).to.equal(0);
    expect(await db!.prisma.processedEvent.count({ where: { eventId: event } })).to.equal(0);
  });

  it('reapplying migrate deploy preserves the catalog, migration ledger, and existing data', async () => {
    const snapshot = async () => ({
      columns: await columns(),
      indexes: (
        await pg.query(
          "SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' ORDER BY indexname",
        )
      ).rows,
      constraints: (
        await pg.query(
          "SELECT conname, pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE connamespace = 'public'::regnamespace ORDER BY conname",
        )
      ).rows,
      triggers: (
        await pg.query(
          'SELECT tgname, pg_get_triggerdef(oid) AS definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY tgname',
        )
      ).rows,
      ledger: (await pg.query('SELECT * FROM _prisma_migrations ORDER BY migration_name')).rows,
    });
    const job = await insertJob();
    const before = await snapshot();
    db!.deployMigrations();
    expect(await snapshot()).to.deep.equal(before);
    expect((await pg.query('SELECT * FROM jobs WHERE id = $1', [job.id])).rows[0]).to.deep.equal(
      job,
    );
  });
});
