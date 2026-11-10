// 모아뷰티 리포트 DB 구조. 기획서 8장(데이터 설계)과 같은 이름을 씁니다.
// 모든 테이블은 별도 스키마(기본 moa) 안에만 만들어서 같은 DB의 다른 프로젝트 데이터를 건드리지 않아요.
export function schemaSql(schema: string): string {
  return `
CREATE SCHEMA IF NOT EXISTS ${schema};
SET search_path TO ${schema};

CREATE TABLE IF NOT EXISTS users (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('viewer','user','admin','superadmin')),
  area          TEXT NOT NULL DEFAULT 'none' CHECK (area IN ('ops','marketing','stock','none')),
  title         TEXT NOT NULL DEFAULT '',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS channels (
  id        SERIAL PRIMARY KEY,
  code      TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  type      TEXT NOT NULL CHECK (type IN ('sales','ad','stock')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS connections (
  id              SERIAL PRIMARY KEY,
  channel_id      INT NOT NULL UNIQUE REFERENCES channels(id),
  key_masked      TEXT NOT NULL DEFAULT '',
  key_encrypted   TEXT NOT NULL DEFAULT '',
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','expired','error')),
  last_checked_at TIMESTAMPTZ,
  updated_by      INT REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS collect_runs (
  id            BIGSERIAL PRIMARY KEY,
  run_date      DATE NOT NULL,
  channel_id    INT NOT NULL REFERENCES channels(id),
  status        TEXT NOT NULL CHECK (status IN ('success','failed','partial')),
  row_count     INT NOT NULL DEFAULT 0,
  error_message TEXT,
  retry_count   INT NOT NULL DEFAULT 0,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_collect_runs_date ON collect_runs(run_date);

CREATE TABLE IF NOT EXISTS products (
  id       SERIAL PRIMARY KEY,
  sku      TEXT NOT NULL UNIQUE,
  name     TEXT NOT NULL,
  category TEXT NOT NULL,
  price    INT NOT NULL CHECK (price > 0)
);

CREATE TABLE IF NOT EXISTS sales_daily (
  id         BIGSERIAL PRIMARY KEY,
  sales_date DATE NOT NULL,
  channel_id INT NOT NULL REFERENCES channels(id),
  product_id INT NOT NULL REFERENCES products(id),
  orders     INT NOT NULL CHECK (orders >= 0),
  quantity   INT NOT NULL CHECK (quantity >= 0),
  amount     BIGINT NOT NULL CHECK (amount >= 0),
  cancels    INT NOT NULL DEFAULT 0 CHECK (cancels >= 0),
  UNIQUE (sales_date, channel_id, product_id)
);
CREATE INDEX IF NOT EXISTS idx_sales_daily_date ON sales_daily(sales_date);

CREATE TABLE IF NOT EXISTS ad_daily (
  id         BIGSERIAL PRIMARY KEY,
  ad_date    DATE NOT NULL,
  channel_id INT NOT NULL REFERENCES channels(id),
  cost       BIGINT NOT NULL CHECK (cost >= 0),
  clicks     INT NOT NULL CHECK (clicks >= 0),
  UNIQUE (ad_date, channel_id)
);

CREATE TABLE IF NOT EXISTS stock_snapshots (
  id          BIGSERIAL PRIMARY KEY,
  snap_date   DATE NOT NULL,
  slot        SMALLINT NOT NULL CHECK (slot IN (1,2)),
  captured_at TIMESTAMPTZ NOT NULL,
  product_id  INT NOT NULL REFERENCES products(id),
  quantity    INT NOT NULL CHECK (quantity >= 0),
  UNIQUE (snap_date, slot, product_id)
);
CREATE INDEX IF NOT EXISTS idx_stock_snap_date ON stock_snapshots(snap_date);

CREATE TABLE IF NOT EXISTS criteria (
  id          SERIAL PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE,
  name        TEXT NOT NULL,
  unit        TEXT NOT NULL DEFAULT '',
  owner_area  TEXT NOT NULL CHECK (owner_area IN ('ops','marketing','stock','admin')),
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS criteria_versions (
  id            SERIAL PRIMARY KEY,
  criteria_id   INT NOT NULL REFERENCES criteria(id),
  value         TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')),
  proposed_by   INT REFERENCES users(id),
  approved_by   INT REFERENCES users(id),
  reason        TEXT NOT NULL DEFAULT '',
  reject_reason TEXT,
  effective_from DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_criteria_versions_criteria ON criteria_versions(criteria_id);

CREATE TABLE IF NOT EXISTS report_templates (
  id                 SERIAL PRIMARY KEY,
  code               TEXT NOT NULL UNIQUE CHECK (code IN ('daily','weekly','monthly')),
  name               TEXT NOT NULL,
  current_version_id INT
);

CREATE TABLE IF NOT EXISTS template_versions (
  id          SERIAL PRIMARY KEY,
  template_id INT NOT NULL REFERENCES report_templates(id),
  version_no  INT NOT NULL,
  config      JSONB NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  source      TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('seed','manual','ai','upload','rollback')),
  created_by  INT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (template_id, version_no)
);

CREATE TABLE IF NOT EXISTS reports (
  id                  SERIAL PRIMARY KEY,
  report_type         TEXT NOT NULL CHECK (report_type IN ('daily','weekly','monthly')),
  report_date         DATE NOT NULL,
  period_start        DATE NOT NULL,
  period_end          DATE NOT NULL,
  template_version_id INT REFERENCES template_versions(id),
  status              TEXT NOT NULL CHECK (status IN ('pending','published','rejected')),
  data_snapshot       JSONB NOT NULL,
  summary_text        TEXT NOT NULL DEFAULT '',
  approved_by         INT REFERENCES users(id),
  approved_at         TIMESTAMPTZ,
  rejected_reason     TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (report_type, report_date)
);
CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);

CREATE TABLE IF NOT EXISTS report_criteria (
  report_id           INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  criteria_version_id INT NOT NULL REFERENCES criteria_versions(id),
  PRIMARY KEY (report_id, criteria_version_id)
);

CREATE TABLE IF NOT EXISTS anomaly_notes (
  id         SERIAL PRIMARY KEY,
  report_id  INT NOT NULL REFERENCES reports(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  note       TEXT NOT NULL,
  author_id  INT REFERENCES users(id),
  source     TEXT NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','ai_draft')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_suggestions (
  id           SERIAL PRIMARY KEY,
  kind         TEXT NOT NULL CHECK (kind IN ('template_change','cause_candidates','stock_suggestion','summary')),
  target_type  TEXT NOT NULL DEFAULT '',
  target_id    INT,
  request_text TEXT NOT NULL DEFAULT '',
  output       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status       TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested','applied','ignored','failed')),
  source       TEXT NOT NULL DEFAULT 'mock' CHECK (source IN ('gpt','mock')),
  requested_by INT REFERENCES users(id),
  decided_by   INT REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  actor_id    INT REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL DEFAULT '',
  target_id   TEXT NOT NULL DEFAULT '',
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at);

-- 규칙을 DB에서도 한 번 더 지킵니다: 공개된 보고서의 숫자와 설명은 바꿀 수 없어요.
CREATE OR REPLACE FUNCTION protect_published_report() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'published' AND (
       NEW.data_snapshot IS DISTINCT FROM OLD.data_snapshot
    OR NEW.summary_text  IS DISTINCT FROM OLD.summary_text
    OR NEW.period_start  IS DISTINCT FROM OLD.period_start
    OR NEW.period_end    IS DISTINCT FROM OLD.period_end
    OR NEW.template_version_id IS DISTINCT FROM OLD.template_version_id
  ) THEN
    RAISE EXCEPTION '공개된 보고서는 고칠 수 없어요.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_published_report ON reports;
CREATE TRIGGER trg_protect_published_report BEFORE UPDATE ON reports
  FOR EACH ROW EXECUTE FUNCTION protect_published_report();

-- 승인된 기준 버전은 바꿀 수 없고 지울 수도 없어요. (과거를 지우지 않고 쌓는 규칙)
CREATE OR REPLACE FUNCTION protect_approved_criteria() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '기준 이력은 지울 수 없어요.';
  END IF;
  IF OLD.status = 'approved' AND (
       NEW.value IS DISTINCT FROM OLD.value
    OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION '승인된 기준은 고칠 수 없어요.';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_approved_criteria ON criteria_versions;
CREATE TRIGGER trg_protect_approved_criteria BEFORE UPDATE OR DELETE ON criteria_versions
  FOR EACH ROW EXECUTE FUNCTION protect_approved_criteria();
`;
}
