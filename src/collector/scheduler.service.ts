// 정해진 시각에 자동으로 일하는 부분이에요. (서버가 켜져 있어야 해요. ENABLE_SCHEDULER=false 로 끌 수 있어요)
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CollectorService } from './collector.service.js';
import { ReportsService } from '../reports/reports.service.js';
import { today, weekday } from '../common/dates.js';

@Injectable()
export class SchedulerService {
  private readonly log = new Logger('Scheduler');
  constructor(private readonly collector: CollectorService, private readonly reports: ReportsService) {}

  private on() {
    return (process.env.ENABLE_SCHEDULER ?? 'true') !== 'false';
  }

  private async safe(name: string, fn: () => Promise<unknown>) {
    if (!this.on()) return;
    try {
      await fn();
      this.log.log(`${name} 완료`);
    } catch (e: any) {
      this.log.warn(`${name} 실패: ${e?.message ?? e}`);
    }
  }

  @Cron('30 7 * * *', { timeZone: 'Asia/Seoul' })
  morningCollect() {
    return this.safe('07:30 판매·광고 수집', () => this.collector.runDay(null, today(), { types: ['sales', 'ad'] }));
  }

  @Cron('5 9 * * *', { timeZone: 'Asia/Seoul' })
  stockMorning() {
    return this.safe('09:05 재고 수집', () => this.collector.runStockSlot(null, 1));
  }

  @Cron('10 9 * * *', { timeZone: 'Asia/Seoul' })
  generateReports() {
    return this.safe('09:10 보고서 만들기', async () => {
      await this.reports.generate(null, 'daily');
      const t = today();
      if (weekday(t) === 1) await this.reports.generate(null, 'weekly', t);
      if (t.endsWith('-01')) await this.reports.generate(null, 'monthly', t);
    });
  }

  @Cron('0 15 * * *', { timeZone: 'Asia/Seoul' })
  stockAfternoon() {
    return this.safe('15:00 재고 수집', () => this.collector.runStockSlot(null, 2));
  }
}
