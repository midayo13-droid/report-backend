// 가상 데이터를 채우는 도구예요.
//   node --env-file=.env scripts/seed.mjs           → 비어 있을 때만 채워요
//   node --env-file=.env scripts/seed.mjs --reset   → 우리 스키마(moa)만 지우고 다시 채워요
// 실행 전에 `npm run build` 가 필요해요. (npm run seed 는 둘 다 해 줘요)
import { DbService } from '../dist/db/db.service.js';
import { SeedService } from '../dist/seed/seed.service.js';

const db = new DbService();
const seed = new SeedService(db);
try {
  if (process.argv.includes('--reset')) {
    console.log(`'${db.schema}' 스키마만 지우고 다시 만들어요...`);
    await seed.reset();
  } else {
    const did = await seed.seedIfEmpty();
    console.log(did ? '가상 데이터를 채웠어요.' : '이미 데이터가 있어서 그대로 뒀어요. (다시 채우려면 --reset)');
  }
  console.log(seed.message);
  const counts = await db.query(`
    SELECT 'users' AS t, count(*)::int AS n FROM users UNION ALL
    SELECT 'products', count(*)::int FROM products UNION ALL
    SELECT 'sales_daily', count(*)::int FROM sales_daily UNION ALL
    SELECT 'ad_daily', count(*)::int FROM ad_daily UNION ALL
    SELECT 'stock_snapshots', count(*)::int FROM stock_snapshots UNION ALL
    SELECT 'collect_runs', count(*)::int FROM collect_runs UNION ALL
    SELECT 'reports', count(*)::int FROM reports UNION ALL
    SELECT 'criteria_versions', count(*)::int FROM criteria_versions UNION ALL
    SELECT 'template_versions', count(*)::int FROM template_versions UNION ALL
    SELECT 'anomaly_notes', count(*)::int FROM anomaly_notes UNION ALL
    SELECT 'ai_suggestions', count(*)::int FROM ai_suggestions UNION ALL
    SELECT 'audit_logs', count(*)::int FROM audit_logs`);
  for (const r of counts) console.log(`  ${r.t}: ${r.n}`);
} catch (e) {
  console.error('실패:', e.message);
  process.exitCode = 1;
} finally {
  await db.onModuleDestroy();
}
