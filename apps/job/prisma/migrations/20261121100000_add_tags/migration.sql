BEGIN;

-- ปรับ Requirement 2026-11-21: Tag ทักษะ (NextJs, NestJs, Rust, ...) — รายการกลางที่ Admin จัดการ
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID,
    "updated_by" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "tags_name_check" CHECK (char_length("name") BETWEEN 1 AND 50),
    CONSTRAINT "tags_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$')
);
CREATE UNIQUE INDEX "tags_slug_key" ON "tags" ("slug");

CREATE TABLE "job_tags" (
    "job_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "job_tags_pkey" PRIMARY KEY ("job_id", "tag_id"),
    CONSTRAINT "job_tags_job_id_fkey" FOREIGN KEY ("job_id")
      REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "job_tags_tag_id_fkey" FOREIGN KEY ("tag_id")
      REFERENCES "tags"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "job_tags_tag_id_job_id_idx" ON "job_tags" ("tag_id", "job_id");

-- เหตุผลที่ Admin ปฏิเสธประกาศ (แทน GET /verification/jobs/{id}/result ที่ถอดแล้ว)
ALTER TABLE "jobs" ADD COLUMN "admin_reason" TEXT;

-- รายการตั้งต้น (insert-if-missing) — Admin เพิ่ม/ปิดใช้งานเองได้ภายหลัง
INSERT INTO "tags" ("name", "slug") VALUES
  ('NextJs', 'nextjs'), ('NestJs', 'nestjs'), ('React', 'react'), ('TypeScript', 'typescript'),
  ('JavaScript', 'javascript'), ('NodeJs', 'nodejs'), ('Rust', 'rust'), ('Go', 'go'), ('Java', 'java'),
  ('Python', 'python'), ('SQL', 'sql'), ('PostgreSQL', 'postgresql'), ('Docker', 'docker'), ('Figma', 'figma'),
  ('SEO', 'seo'), ('Excel', 'excel')
ON CONFLICT ("slug") DO NOTHING;

COMMIT;
