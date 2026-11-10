import { Module, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { DbService } from './db/db.service.js';
import { AuditService } from './audit/audit.service.js';
import { AuthController, AuthGuard, AuthService } from './auth/auth.js';
import { CriteriaController, CriteriaService } from './criteria/criteria.service.js';
import { TemplatesController, TemplatesService } from './templates/templates.service.js';
import { ReportsController, ReportsService } from './reports/reports.service.js';
import { PdfService } from './reports/pdf.service.js';
import { AiController, AiService } from './ai/ai.service.js';
import { CollectorController, CollectorService } from './collector/collector.service.js';
import { SchedulerService } from './collector/scheduler.service.js';
import { SeedService } from './seed/seed.service.js';
import { AuditController, ConnectionsController, DemoController, HealthController, UsersController } from './admin/admin.controllers.js';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [
    HealthController,
    AuthController,
    ReportsController,
    TemplatesController,
    CriteriaController,
    CollectorController,
    AiController,
    UsersController,
    ConnectionsController,
    AuditController,
    DemoController,
  ],
  providers: [
    DbService,
    AuditService,
    AuthService,
    CriteriaService,
    TemplatesService,
    PdfService,
    ReportsService,
    AiService,
    CollectorService,
    SchedulerService,
    SeedService,
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements OnApplicationBootstrap {
  private readonly log = new Logger('App');
  constructor(private readonly db: DbService, private readonly seed: SeedService) {}

  /** 서버가 켜질 때: 테이블이 없으면 만들고, 비어 있으면 가상 데이터를 채워요. (서버 시작은 기다리지 않아요) */
  async onApplicationBootstrap() {
    await this.db.ensureSchema();
    if ((process.env.SEED_ON_START ?? 'true') !== 'false') {
      this.seed.seedIfEmpty().catch((e) => this.log.error(`가상 데이터 만들기 실패: ${e?.message ?? e}`));
    }
  }
}
