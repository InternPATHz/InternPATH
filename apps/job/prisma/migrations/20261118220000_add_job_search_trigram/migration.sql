BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "jobs_job_title_trgm_idx" ON "jobs" USING GIN ("job_title" gin_trgm_ops);

COMMIT;
