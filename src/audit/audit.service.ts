import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../db/db.service.js';

// 누가 언제 무엇을 했는지 남기는 이력이에요. 이력은 지우거나 고치지 않고 쌓기만 해요.
@Injectable()
export class AuditService {
  private readonly log = new Logger('Audit');
  constructor(private readonly db: DbService) {}

  async write(actorId: number | null, action: string, targetType = '', targetId: string | number = '', detail: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.db.query(
        'INSERT INTO audit_logs (actor_id, action, target_type, target_id, detail) VALUES ($1,$2,$3,$4,$5::jsonb)',
        [actorId, action, targetType, String(targetId), JSON.stringify(detail)],
      );
    } catch (e: any) {
      this.log.warn(`이력 저장에 실패했어요: ${e?.message}`);
    }
  }

  async list(opts: { actorId?: number; action?: string; limit?: number }) {
    const where: string[] = [];
    const params: unknown[] = [];
    if (opts.actorId) {
      params.push(opts.actorId);
      where.push(`a.actor_id = $${params.length}`);
    }
    if (opts.action) {
      params.push(`${opts.action}%`);
      where.push(`a.action LIKE $${params.length}`);
    }
    params.push(Math.min(Math.max(opts.limit ?? 100, 1), 300));
    return this.db.query(
      `SELECT a.id, a.action, a.target_type, a.target_id, a.detail, a.created_at, u.name AS actor_name, u.title AS actor_title
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
  }
}
