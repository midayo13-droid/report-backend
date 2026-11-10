import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import pg from 'pg';
import { schemaSql } from './schema.js';

// 날짜는 문자열('2026-11-10')로, 큰 숫자와 소수는 숫자로 받아요.
pg.types.setTypeParser(1082, (v: string) => v);
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1700, (v: string) => Number(v));

// 같은 DB 안의 다른 프로젝트 스키마는 절대 건드리지 않아요.
const BLOCKED_SCHEMAS = ['public', 'hw2', 'pg_catalog', 'information_schema'];

@Injectable()
export class DbService implements OnModuleDestroy {
  private readonly log = new Logger('Db');
  readonly schema: string;
  readonly pool: pg.Pool;

  constructor() {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error('DATABASE_URL 이 없어요. backend/.env 파일을 확인해 주세요.');
    }
    const schema = (process.env.DB_SCHEMA ?? 'moa').toLowerCase();
    if (!/^[a-z][a-z0-9_]{1,30}$/.test(schema) || BLOCKED_SCHEMAS.includes(schema)) {
      throw new Error(`DB_SCHEMA 값(${schema})은 쓸 수 없어요. 새 이름(예: moa)을 쓰세요.`);
    }
    this.schema = schema;
    this.pool = new pg.Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 6,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 20000,
      options: `-c search_path=${schema}`,
    });
    this.pool.on('error', (e) => this.log.error(`DB 연결 오류: ${e.message}`));
  }

  async query<T = any>(text: string, params: unknown[] = []): Promise<T[]> {
    const r = await this.pool.query(text, params as any[]);
    return r.rows as T[];
  }

  async one<T = any>(text: string, params: unknown[] = []): Promise<T | undefined> {
    const rows = await this.query<T>(text, params);
    return rows[0];
  }

  async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(c);
      await c.query('COMMIT');
      return out;
    } catch (e) {
      await c.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }

  /** 테이블이 없으면 만들어요. 있으면 그대로 둬요. */
  async ensureSchema(): Promise<void> {
    await this.pool.query(schemaSql(this.schema));
    this.log.log(`스키마 '${this.schema}' 준비 완료`);
  }

  /** 시연용 초기화: 우리 스키마만 지우고 다시 만들어요. */
  async dropOurSchema(): Promise<void> {
    await this.pool.query(`DROP SCHEMA IF EXISTS ${this.schema} CASCADE`);
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool.end();
  }
}
