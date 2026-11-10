// DB를 읽기만 해서 어떤 스키마와 테이블이 있는지 보여 주는 점검 도구예요. (아무것도 바꾸지 않아요)
// 실행: node --env-file=.env scripts/inspect-db.mjs
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL 이 .env 에 없어요.');
  process.exit(1);
}

const client = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query('SET default_transaction_read_only = on');

const ver = await client.query('select version() as v, current_database() as db, current_user as usr');
console.log('연결 성공:', ver.rows[0].db, '/', ver.rows[0].usr);
console.log(ver.rows[0].v);

const schemas = await client.query(
  `select schema_name from information_schema.schemata
   where schema_name not in ('pg_catalog','information_schema','pg_toast') and schema_name not like 'pg_temp%' and schema_name not like 'pg_toast_temp%'
   order by 1`,
);
console.log('\n스키마:', schemas.rows.map((r) => r.schema_name).join(', ') || '(없음)');

const tables = await client.query(
  `select table_schema, table_name, table_type from information_schema.tables
   where table_schema not in ('pg_catalog','information_schema') order by 1,2`,
);
if (tables.rows.length === 0) {
  console.log('\n테이블: 없음 (빈 DB예요)');
} else {
  console.log(`\n테이블 ${tables.rows.length}개:`);
  for (const t of tables.rows) {
    let n = '?';
    try {
      const c = await client.query(`select count(*)::int as n from "${t.table_schema}"."${t.table_name}"`);
      n = c.rows[0].n;
    } catch (e) {
      n = '조회 실패';
    }
    console.log(`  ${t.table_schema}.${t.table_name} (${t.table_type}) 행 수: ${n}`);
  }
}

const priv = await client.query(
  `select has_database_privilege(current_user, current_database(), 'CREATE') as can_create_schema`,
);
console.log('\n스키마 만들기 권한:', priv.rows[0].can_create_schema ? '있음' : '없음');
await client.end();
