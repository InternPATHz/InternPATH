BEGIN;

CREATE TYPE "report_round_status" AS ENUM ('ACTIVE', 'CLOSED', 'DECIDED');
CREATE TYPE "report_round_decision" AS ENUM ('REMOVE', 'RESTORE');
CREATE TYPE "report_round_decider" AS ENUM ('SYSTEM', 'ADMIN');

CREATE TABLE "report_rounds" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "job_id" UUID NOT NULL,
    "queue_item_id" UUID NOT NULL,
    "status" "report_round_status" NOT NULL,
    "reached_at" TIMESTAMPTZ(6),
    "decision" "report_round_decision",
    "decided_at" TIMESTAMPTZ(6),
    "decided_by" "report_round_decider",
    "correlation_id" UUID,
    "suspended_from_status" "job_status",
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closed_at" TIMESTAMPTZ(6),

    CONSTRAINT "report_rounds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "report_rounds_job_id_fkey" FOREIGN KEY ("job_id")
      REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "report_rounds_previous_status_check" CHECK ("suspended_from_status" IN ('PUBLISHED', 'CLOSED')),
    CONSTRAINT "report_rounds_state_check" CHECK (
      ("status" = 'ACTIVE' AND "reached_at" IS NOT NULL AND "suspended_from_status" IS NOT NULL
        AND "decision" IS NULL AND "decided_at" IS NULL AND "closed_at" IS NULL
        AND "decided_by" IS NULL AND "correlation_id" IS NULL)
      OR ("status" = 'DECIDED' AND "reached_at" IS NULL AND "suspended_from_status" IS NULL
        AND "decision" IS NOT NULL AND "decided_at" IS NOT NULL AND "closed_at" IS NULL
        AND "decided_by" IS NOT NULL AND "correlation_id" IS NOT NULL)
      OR ("status" = 'CLOSED' AND "reached_at" IS NOT NULL
        AND "decision" IS NOT NULL AND "decided_at" IS NOT NULL AND "closed_at" IS NOT NULL
        AND "decided_by" IS NOT NULL AND "correlation_id" IS NOT NULL
        AND ("decision" = 'RESTORE' OR "suspended_from_status" IS NOT NULL))
    )
);

CREATE UNIQUE INDEX "report_rounds_job_id_queue_item_id_key" ON "report_rounds" ("job_id", "queue_item_id");
CREATE INDEX "report_rounds_job_id_reached_at_idx" ON "report_rounds" ("job_id", "reached_at");

-- Keep CLOSED rounds for replay protection while allowing a subsequent round to open.
CREATE UNIQUE INDEX "report_rounds_one_active_per_job_idx"
  ON "report_rounds" ("job_id") WHERE "status" = 'ACTIVE';

COMMIT;
