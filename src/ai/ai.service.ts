// AI 도우미. GPT를 쓰되, 키가 없거나 호출이 실패하면 미리 정해 둔 규칙(모의 응답)으로 대신해요.
// 원칙: AI는 제안과 초안까지만 해요. 숫자 계산은 시스템이 하고, AI가 낸 결과는 사람이 확인하고 적용해야 반영돼요.
import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Injectable, Logger, NotFoundException, Param, Post, Query } from '@nestjs/common';
import OpenAI from 'openai';
import { DbService } from '../db/db.service.js';
import { AuditService } from '../audit/audit.service.js';
import { TemplatesService } from '../templates/templates.service.js';
import { CurrentUser, Roles, canSeeUnpublished, type AuthUser } from '../auth/auth.js';
import { stockSentence, templateSummary } from '../domain/report-builder.js';
import {
  CUSTOM_GROUPS,
  CUSTOM_METRICS,
  CUSTOM_SHAPES,
  MAX_CUSTOM_CHARTS,
  customOptions,
  isCustomKey,
  newCustomKey,
  validateCustomSpec,
  type CustomMetric,
  type CustomGroup,
} from '../domain/custom-chart.js';
import {
  CHART_LABEL,
  KPI_ITEMS,
  KPI_LABEL,
  SECTION_LABEL,
  allowedKeys,
  chartChoices,
  describeChanges,
  validateTemplateConfig,
  type KpiItem,
  type TemplateConfig,
  type TemplateType,
} from '../domain/template-config.js';

const TYPES: TemplateType[] = ['daily', 'weekly', 'monthly'];
const MODEL_PREFS = ['gpt-4.1-mini', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4o', 'gpt-5-mini', 'gpt-5', 'gpt-3.5-turbo'];

const numbersIn = (t: string) => (t.replace(/,/g, '').match(/\d+(?:\.\d+)?/g) ?? []).map(String);

// ---------------------------------------------------------------- 양식 변경 (규칙으로 읽는 모의 응답)
const LEX: [RegExp, string][] = [
  [/취소율\s*(추이|그래프)/, 'chart_cancel_trend'],
  [/광고\s*효율|효율/, 'chart_ad_efficiency'],
  [/매출과\s*광고비|매출\s*(그래프|추이)|광고비\s*(그래프|추이)/, 'chart_sales_ad'],
  [/판매처|비중|채널/, 'chart_channel_share'],
  [/상품|순위|랭킹|top/i, 'chart_top_products'],
  [/재고/, 'stock_table'],
  [/목표/, 'target_progress'],
  [/핵심\s*숫자|핵심|kpi/i, 'kpis'],
  [/요약/, 'summary'],
  [/이유|메모/, 'notes'],
];

const CRITERIA_WORDS = /계산|공식|기준|임계|환불|몇\s*개\s*(이하|미만)|이하로|미만으로/;
const UNSUPPORTED_WORDS = /로고|이미지|사진|색상|색깔|컬러|폰트|글꼴|글자\s*크기/;

/** "카테고리별 매출을 원그래프로 추가해줘" 같은 말을 새 그래프 설정으로 읽어요. 해당하지 않으면 undefined를 돌려줘요. */
function parseCustomChartRequest(type: TemplateType, before: TemplateConfig, text: string): { config?: TemplateConfig; message: string } | undefined {
  const wantsNew = /(추가|만들|그려|보여\s*줘|넣어)/.test(text) && !/(바꿔|옮겨|올려|내려|맨\s*(위|아래)|빼|숨기|지워|삭제)/.test(text);
  if (!wantsNew) return undefined;
  const groupBy: CustomGroup | '' = /카테고리/.test(text) ? 'category' : /(일별|날짜별|일자별|추이)/.test(text) ? 'date' : /(판매처|채널)\s*별/.test(text) ? 'channel' : /상품\s*별/.test(text) ? 'product' : '';
  if (!groupBy) return undefined;

  const ratio = /(광고\s*효율|효율|취소율|광고비)/.exec(text);
  if (ratio) {
    const what = ratio[1].includes('광고비') ? '광고비는 아직 그래프 추가에서 고를 수 없어요.' : `${ratio[1].includes('취소') ? '취소율' : '광고 효율'}은 비율이라 나눠서 보여 드릴 수 없어요.`;
    return { message: `${what} 대신 매출, 주문 수, 판매 수량, 취소 건수를 ${CUSTOM_GROUPS[groupBy].label}별로 보여 드릴까요?` };
  }
  const metric: CustomMetric | '' = /취소\s*(건수|수|건)/.test(text) ? 'cancels' : /판매\s*수량|판매량|수량/.test(text) ? 'quantity' : /주문/.test(text) ? 'orders' : /(매출|판매액|금액)/.test(text) ? 'sales' : '';
  if (!metric) return { message: '무엇을 보고 싶은지 말해 주세요. 매출, 주문 수, 판매 수량, 취소 건수 중에서 고를 수 있어요.' };

  const shape = /꺾은선|선\s*그래프/.test(text) ? 'line' : /세로\s*막대/.test(text) ? 'vbar' : /가로\s*막대/.test(text) ? 'hbar' : /막대/.test(text) ? (groupBy === 'date' ? 'vbar' : 'hbar') : /(원|도넛)/.test(text) ? 'donut' : /표/.test(text) ? 'table' : groupBy === 'date' ? 'line' : /비중/.test(text) ? 'donut' : 'hbar';
  let days = groupBy === 'date' ? 14 : 0;
  const n = text.match(/최근\s*(\d+)\s*일/);
  if (n) days = Number(n[1]);
  else if (/(일주일|1\s*주일|한\s*주)/.test(text)) days = 7;
  else if (/(2\s*주|이\s*주|두\s*주)/.test(text)) days = 14;
  else if (/(한\s*달|한달|1\s*개월|30\s*일)/.test(text)) days = 30;
  const limit = /(\d+)\s*개/.exec(text) ? Number(/(\d+)\s*개/.exec(text)![1]) : 5;

  const check = validateCustomSpec({ metric, groupBy, shape, days, limit });
  if (!check.ok || !check.spec) return { message: `${check.errors[0]} 다시 말해 주세요.` };
  if (before.sections.filter((s) => isCustomKey(s.key)).length >= MAX_CUSTOM_CHARTS) {
    return { message: `추가한 그래프가 이미 ${MAX_CUSTOM_CHARTS}개예요. 양식 설정에서 하나를 지운 뒤 다시 말해 주세요.` };
  }
  const cfg: TemplateConfig = JSON.parse(JSON.stringify(before));
  const at = cfg.sections.findIndex((s) => s.key === 'stock_table');
  cfg.sections.splice(at === -1 ? cfg.sections.length : at, 0, { key: newCustomKey(), enabled: true, custom: check.spec });
  const s = check.spec;
  return { config: cfg, message: `"${s.title}" 그래프를 추가할게요. (${CUSTOM_METRICS[s.metric].label} × ${CUSTOM_GROUPS[s.groupBy].label} × ${CUSTOM_SHAPES[s.shape]}${s.days ? `, 최근 ${s.days}일` : ''}) 아래 변경 내용을 확인하고, 괜찮으면 적용해 주세요.` };
}

export function parseTemplateRequest(type: TemplateType, before: TemplateConfig, text: string): { config?: TemplateConfig; message: string; redirect?: 'criteria' | 'unsupported' } {
  if (UNSUPPORTED_WORDS.test(text)) return { redirect: 'unsupported', message: '로고나 색, 글꼴은 양식 도우미로 바꿀 수 없어요. 항목, 순서, 그래프 종류, 표시 개수, 제목 문구만 바꿀 수 있어요.' };
  if (CRITERIA_WORDS.test(text) && !/제목|문구/.test(text)) {
    return { redirect: 'criteria', message: '계산 방법이나 경고 기준은 "기준"이라서 양식 도우미가 바꿀 수 없어요. 기준 관리에서 수정안을 올려 주세요.' };
  }
  const custom = parseCustomChartRequest(type, before, text);
  if (custom) return custom;
  const cfg: TemplateConfig = JSON.parse(JSON.stringify(before));
  const keys = allowedKeys(type);

  // 제목, 맨 아래 문구
  const quoted = text.match(/['"“‘]([^'"”’]{1,80})['"”’]/);
  if (quoted && /제목/.test(text)) cfg.title = quoted[1].trim().slice(0, 40);
  if (quoted && /(맨\s*아래|아래쪽|끝)\s*문구|푸터|footer/i.test(text)) cfg.footer = quoted[1].trim().slice(0, 80);

  // 어느 항목을 말하는지 찾기
  let target: string | undefined;
  for (const [re, key] of LEX) {
    if (re.test(text)) {
      if (!keys.includes(key)) {
        if (key === 'chart_cancel_trend' || key === 'target_progress') return { message: `"${SECTION_LABEL[key]}"은(는) 월말 양식에만 있어요.` };
        continue;
      }
      target = key;
      break;
    }
  }
  const footerOnly = !!quoted && /(맨\s*아래|아래쪽|끝)\s*문구|푸터|footer/i.test(text);
  const titleOnly = !!quoted && /제목/.test(text);

  if (target && !footerOnly && !titleOnly) {
    const sec = cfg.sections.find((s) => s.key === target)!;
    const hide = /빼|숨기|숨겨|없애|끄|안\s*보여|제외|삭제/.test(text);
    const show = !hide && /넣어|추가|보여|켜|다시|살려/.test(text);

    // 핵심 숫자 항목 빼기/넣기
    if (target === 'kpis') {
      const named = (Object.entries(KPI_LABEL) as [KpiItem, string][]).filter(([, label]) => text.replace(/핵심\s*숫자/g, '').includes(label)).map(([k]) => k);
      if (named.length && (hide || show)) {
        const set = new Set<KpiItem>(sec.items ?? [...KPI_ITEMS]);
        for (const n of named) (hide ? set.delete(n) : set.add(n));
        if (set.size === 0) return { message: '핵심 숫자는 1개 이상 보여 줘야 해요.' };
        sec.items = KPI_ITEMS.filter((i) => set.has(i));
      } else if (hide) sec.enabled = false;
      else if (show) sec.enabled = true;
    } else {
      if (hide) sec.enabled = false;
      else if (show) sec.enabled = true;
    }

    // 그래프 종류
    const asked = /꺾은선|선\s*그래프/.test(text) ? 'line' : /가로\s*막대/.test(text) ? 'hbar' : /막대/.test(text) ? 'bar' : /(원|도넛)\s*(그래프|모양)?(으로|로)/.test(text) ? 'donut' : /표로/.test(text) ? 'table' : '';
    if (asked) {
      if (chartChoices(target).includes(asked)) sec.chart = asked;
      else return { message: `"${SECTION_LABEL[target]}"의 그래프 종류는 ${chartChoices(target).map((c) => CHART_LABEL[c]).join(', ') || '바꿀 수 없어요'} 중에서 고를 수 있어요.` };
    }

    // 재고 표시 조건, 표시 개수
    if (target === 'stock_table') {
      if (/위험\s*(상품)?\s*만|위험한\s*것만/.test(text)) sec.filter = 'danger';
      else if (/전체|모두|다\s*보여/.test(text)) sec.filter = 'all';
    }
    const lim = text.match(/(\d+)\s*개/);
    if (lim && (target === 'stock_table' || target === 'chart_top_products')) {
      const n = Number(lim[1]);
      if (n < 3 || n > 20) return { message: '표시 개수는 3~20개 사이로 말해 주세요.' };
      sec.limit = n;
    }

    // 위치 옮기기
    const from = cfg.sections.findIndex((s) => s.key === target);
    let to = from;
    const nth = text.match(/(\d+)\s*번째/);
    if (nth) to = Math.min(Math.max(Number(nth[1]) - 1, 0), cfg.sections.length - 1);
    else if (/맨\s*(위|앞)|처음|첫\s*번째|제일\s*위|가장\s*위/.test(text)) to = 0;
    else if (/맨\s*(아래|뒤)|마지막|제일\s*아래|가장\s*아래/.test(text)) to = cfg.sections.length - 1;
    else if (/위로|앞으로|올려/.test(text)) to = Math.max(0, from - 1);
    else if (/아래로|뒤로|내려/.test(text)) to = Math.min(cfg.sections.length - 1, from + 1);
    if (to !== from) {
      const [moved] = cfg.sections.splice(from, 1);
      cfg.sections.splice(to, 0, moved);
    }
  }

  const changes = describeChanges(before, cfg);
  if (!changes.length) {
    return { message: '어떻게 바꿔야 할지 잘 모르겠어요. 예: "광고 효율 그래프를 맨 위로 올려줘", "판매처 비중을 막대로 바꿔줘", "재고 표는 위험 상품만 보여줘"처럼 말해 주세요.' };
  }
  return { config: cfg, message: '아래 변경 내용을 확인하고, 괜찮으면 적용해 주세요.' };
}

// ---------------------------------------------------------------- 서비스
@Injectable()
export class AiService {
  private readonly log = new Logger('Ai');
  private client: OpenAI | null = null;
  private model?: string;
  lastError = '';

  constructor(private readonly db: DbService, private readonly audit: AuditService, private readonly templates: TemplatesService) {}

  private openai(): OpenAI | null {
    const key = (process.env.GPT_API_KEY ?? '').trim();
    if (!key) return null;
    if (!this.client) this.client = new OpenAI({ apiKey: key, timeout: 25000, maxRetries: 0 });
    return this.client;
  }

  status() {
    return { gptConfigured: !!(process.env.GPT_API_KEY ?? '').trim(), model: this.model ?? (process.env.GPT_MODEL || null), lastError: this.lastError || null };
  }

  private async pickModel(client: OpenAI): Promise<string | undefined> {
    if (this.model) return this.model;
    const env = (process.env.GPT_MODEL ?? '').trim();
    if (env) return (this.model = env);
    const page: any = await client.models.list();
    const ids: string[] = (page.data ?? []).map((m: any) => m.id);
    this.model = MODEL_PREFS.find((p) => ids.includes(p)) ?? ids.find((id) => /^gpt-/.test(id) && !/(audio|realtime|image|tts|transcribe|search|instruct|embedding|moderation)/.test(id));
    return this.model;
  }

  /** GPT에게 JSON으로 답해 달라고 부탁해요. 안 되면 null을 돌려줘서 모의 응답으로 넘어가요. */
  private async gpt(system: string, user: string): Promise<any | null> {
    const client = this.openai();
    if (!client) return null;
    try {
      const model = await this.pickModel(client);
      if (!model) throw new Error('사용할 수 있는 GPT 모델을 찾지 못했어요.');
      const res = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: `반드시 JSON 형식으로만 답하세요. ${system}` },
          { role: 'user', content: user },
        ],
        response_format: { type: 'json_object' },
      });
      const text = res.choices?.[0]?.message?.content ?? '';
      this.lastError = '';
      return JSON.parse(text);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e).replace(/sk-[A-Za-z0-9_-]+/g, 'sk-***').slice(0, 200);
      this.log.warn(`GPT 호출 실패 → 모의 응답으로 대신해요: ${this.lastError}`);
      return null;
    }
  }

  private async save(kind: string, targetType: string, targetId: number | null, request: string, output: unknown, status: string, source: 'gpt' | 'mock', user: AuthUser) {
    const row = await this.db.one<{ id: number }>(
      `INSERT INTO ai_suggestions (kind,target_type,target_id,request_text,output,status,source,requested_by) VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
      [kind, targetType, targetId, request.slice(0, 300), JSON.stringify(output), status, source, user.id],
    );
    await this.audit.write(user.id, `ai.${kind}`, targetType, targetId ?? '', { suggestionId: row!.id, source, status });
    return row!.id;
  }

  private async reportRow(user: AuthUser, id: number) {
    if (!Number.isInteger(id)) throw new NotFoundException('보고서를 찾을 수 없어요.');
    const r = await this.db.one<any>('SELECT id, report_type, report_date, status, data_snapshot FROM reports WHERE id = $1', [id]);
    if (!r) throw new NotFoundException('보고서를 찾을 수 없어요.');
    if (r.status !== 'published' && !canSeeUnpublished(user)) throw new ForbiddenException('승인 전 보고서는 볼 수 없어요.');
    return r;
  }

  // ---------- 1. 양식 변경 도우미
  async templateChange(user: AuthUser, templateCode: string, request: string) {
    if (!TYPES.includes(templateCode as TemplateType)) throw new BadRequestException('양식 종류가 올바르지 않아요.');
    const text = String(request ?? '').trim();
    if (text.length < 2 || text.length > 200) throw new BadRequestException('바꾸고 싶은 내용을 2~200자로 말해 주세요.');
    const type = templateCode as TemplateType;
    const cur = await this.templates.currentConfig(type);
    const tpl = await this.db.one<{ id: number }>('SELECT id FROM report_templates WHERE code = $1', [type]);

    let source: 'gpt' | 'mock' = 'mock';
    let outcome: { config?: TemplateConfig; message: string; redirect?: 'criteria' | 'unsupported' } | undefined;

    // 기준을 바꾸려는 요청은 GPT에 묻지 않고 바로 안내해요. (기준은 수정안 → 승인 흐름으로만 바뀌어요)
    const rule = parseTemplateRequest(type, cur.config, text);
    if (rule.redirect) {
      outcome = rule;
    } else {
      const g = await this.gpt(
        '당신은 보고서 양식 변경 도우미입니다. 사용자의 요청을 현재 양식 설정(JSON)에 반영한 새 설정을 JSON으로 돌려주세요. ' +
          '바꿀 수 있는 것은 sections 의 순서, enabled, chart 종류, filter, limit, items, 그리고 title, footer 뿐입니다. ' +
          '새 그래프를 추가해 달라는 요청이면 sections 에 {"key":"custom:<영문소문자·숫자 6~10자>","enabled":true,"custom":{"title","metric","groupBy","shape","days","limit"}} 항목을 하나 더하세요. ' +
          'metric·groupBy·shape·days 는 customChartOptions 안의 값만 쓰고, 날짜(date)별은 꺾은선(line)·세로 막대(vbar)만, 나머지는 원(donut)·가로 막대(hbar)·표(table)만 가능하며, 날짜별은 days 를 7·14·30 중에서 고르세요. ' +
          '광고 효율·취소율·광고비 같은 것은 customChartOptions 에 없으므로 만들 수 없다고 "unsupported" 로 답하세요. ' +
          '계산 방법이나 경고 기준, 숫자 값은 절대 바꾸지 마세요. 그런 요청이면 action 을 "criteria_redirect" 로 하세요. 로고·색·글꼴 요청은 "unsupported" 입니다. ' +
          '출력 형식: {"action":"change"|"criteria_redirect"|"unsupported","message":"사용자에게 보여 줄 한국어 한 문장","config":{title,footer,sections:[...]}}',
        JSON.stringify({
          request: text,
          currentConfig: cur.config,
          allowedSectionKeys: allowedKeys(type).map((k) => ({ key: k, label: SECTION_LABEL[k], charts: chartChoices(k) })),
          kpiItems: KPI_ITEMS,
          customChartOptions: customOptions(),
          stockFilters: ['all', 'danger'],
          limitRange: [3, 20],
        }),
      );
      if (g?.action === 'criteria_redirect') outcome = { redirect: 'criteria', message: String(g.message ?? '계산 방법이나 경고 기준은 기준 관리에서 수정안으로 올려 주세요.').slice(0, 200) };
      else if (g?.action === 'unsupported') outcome = { redirect: 'unsupported', message: String(g.message ?? '그 요청은 양식 도우미로 바꿀 수 없어요.').slice(0, 200) };
      else if (g?.action === 'change' && g.config) {
        const check = validateTemplateConfig(type, g.config);
        if (check.ok && check.config) {
          // 새로 추가한 그래프가 재고 표·확인 메모 뒤(맨 끝)에 붙으면, 다른 그래프 옆(재고 표 앞)으로 옮겨요.
          const had = new Set(cur.config.sections.map((s: any) => s.key));
          const secs = check.config.sections;
          for (const key of secs.filter((s: any) => String(s.key).startsWith('custom:') && !had.has(s.key)).map((s: any) => s.key)) {
            const i = secs.findIndex((s: any) => s.key === key);
            const stockAt = secs.findIndex((s: any) => s.key === 'stock_table');
            if (stockAt !== -1 && i > stockAt) secs.splice(stockAt, 0, secs.splice(i, 1)[0]);
          }
        }
        if (check.ok && check.config && describeChanges(cur.config, check.config).length) {
          outcome = { config: check.config, message: String(g.message ?? '아래 변경 내용을 확인하고, 괜찮으면 적용해 주세요.').slice(0, 200) };
          source = 'gpt';
        }
      }
      if (!outcome) outcome = rule; // GPT 결과가 없거나 허용 범위를 벗어나면 규칙으로 읽은 결과를 써요.
    }

    const changes = outcome.config ? describeChanges(cur.config, outcome.config) : [];
    const failed = !outcome.config;
    const output = { templateCode: type, baseVersionId: cur.versionId, message: outcome.message, redirect: outcome.redirect ?? null, configAfter: outcome.config ?? null, changes };
    const id = await this.save('template_change', 'template', tpl?.id ?? null, text, output, failed ? 'failed' : 'suggested', source, user);
    return { id, source, fallback: !this.status().gptConfigured || (source === 'mock' && !!this.lastError), status: failed ? 'failed' : 'suggested', ...output };
  }

  async applyTemplateChange(user: AuthUser, id: number) {
    const s = await this.db.one<any>('SELECT * FROM ai_suggestions WHERE id = $1 AND kind = $2', [id, 'template_change']);
    if (!s) throw new NotFoundException('제안을 찾을 수 없어요.');
    if (s.status !== 'suggested') throw new ConflictException('이미 처리됐거나 적용할 수 없는 제안이에요.');
    if (s.requested_by !== user.id && user.role !== 'admin') throw new ForbiddenException('내가 요청한 제안만 적용할 수 있어요.');
    const out = s.output;
    const saved = await this.templates.save(user, out.templateCode, out.configAfter, `AI 제안: ${String(s.request_text).slice(0, 80)}`, 'ai');
    await this.db.query(`UPDATE ai_suggestions SET status='applied', decided_by=$2, decided_at=now() WHERE id=$1`, [id, user.id]);
    await this.audit.write(user.id, 'ai.apply', 'ai_suggestion', id, { kind: 'template_change', version: saved.versionNo });
    return { id, status: 'applied', version: saved };
  }

  async ignore(user: AuthUser, id: number) {
    const s = await this.db.one<any>('SELECT id, status, requested_by FROM ai_suggestions WHERE id = $1', [id]);
    if (!s) throw new NotFoundException('제안을 찾을 수 없어요.');
    if (s.status !== 'suggested') throw new ConflictException('이미 처리된 제안이에요.');
    if (s.requested_by !== user.id && user.role !== 'admin') throw new ForbiddenException('내가 요청한 제안만 처리할 수 있어요.');
    await this.db.query(`UPDATE ai_suggestions SET status='ignored', decided_by=$2, decided_at=now() WHERE id=$1`, [id, user.id]);
    await this.audit.write(user.id, 'ai.ignore', 'ai_suggestion', id, {});
    return { id, status: 'ignored' };
  }

  async markUsed(user: AuthUser, id: number) {
    const s = await this.db.one<any>('SELECT id, status FROM ai_suggestions WHERE id = $1', [id]);
    if (!s) throw new NotFoundException('제안을 찾을 수 없어요.');
    if (s.status === 'suggested') await this.db.query(`UPDATE ai_suggestions SET status='applied', decided_by=$2, decided_at=now() WHERE id=$1`, [id, user.id]);
    return { id, status: 'applied' };
  }

  // ---------- 2. 이상 숫자의 원인 후보와 확인 메모 초안
  private async signals(snap: any) {
    const m = snap.meta;
    const rows = await this.db.query<any>(
      `SELECT c.name, 'channel' AS kind,
              coalesce(sum(s.amount) FILTER (WHERE s.sales_date BETWEEN $1 AND $2),0) AS cur,
              coalesce(sum(s.amount) FILTER (WHERE s.sales_date BETWEEN $3 AND $4),0) AS prev
       FROM sales_daily s JOIN channels c ON c.id = s.channel_id WHERE s.sales_date BETWEEN $3 AND $2 GROUP BY c.name
       UNION ALL
       SELECT p.name, 'product',
              coalesce(sum(s.amount) FILTER (WHERE s.sales_date BETWEEN $1 AND $2),0),
              coalesce(sum(s.amount) FILTER (WHERE s.sales_date BETWEEN $3 AND $4),0)
       FROM sales_daily s JOIN products p ON p.id = s.product_id WHERE s.sales_date BETWEEN $3 AND $2 GROUP BY p.name
       UNION ALL
       SELECT c.name, 'ad',
              coalesce(sum(a.cost) FILTER (WHERE a.ad_date BETWEEN $1 AND $2),0),
              coalesce(sum(a.cost) FILTER (WHERE a.ad_date BETWEEN $3 AND $4),0)
       FROM ad_daily a JOIN channels c ON c.id = a.channel_id WHERE a.ad_date BETWEEN $3 AND $2 GROUP BY c.name`,
      [m.periodStart, m.periodEnd, m.prevStart, m.prevEnd],
    );
    const fmt = (n: number) => `${Math.round(n / 10000).toLocaleString('ko-KR')}만원`;
    const sig: { id: string; text: string; impact: number }[] = [];
    for (const r of rows) {
      if (r.prev <= 0 && r.cur <= 0) continue;
      const diff = r.cur - r.prev;
      const rate = r.prev > 0 ? Math.round((diff / r.prev) * 1000) / 10 : null;
      const label = r.kind === 'channel' ? `${r.name} 매출` : r.kind === 'product' ? `${r.name} 매출` : `${r.name} 광고비`;
      sig.push({ id: `${r.kind}:${r.name}`, text: `${label}: ${rate == null ? '새로 생겼어요' : `${diff >= 0 ? '+' : '−'}${Math.abs(rate)}%`} (${fmt(r.prev)} → ${fmt(r.cur)})`, impact: Math.abs(diff) * (r.kind === 'product' ? 0.7 : 1) });
    }
    const k = snap.kpis;
    if (k.delta.cancelRate != null && Math.abs(k.delta.cancelRate) >= 0.8) sig.push({ id: 'cancel', text: `취소율이 ${k.delta.cancelRate > 0 ? '+' : '−'}${Math.abs(k.delta.cancelRate)}%p 변했어요 (지금 ${k.cancelRate}%)`, impact: Math.abs(k.delta.cancelRate) * k.sales * 0.02 });
    for (const i of snap.issues ?? []) sig.push({ id: `issue:${i.channel}`, text: `${i.channel} 수집이 ${i.status === 'partial' ? '일부만 됐어요' : i.status === 'failed' ? '실패했어요' : '누락이 의심돼요'}`, impact: k.sales * 0.3 });
    if (snap.flags?.adEfficiencyLow) sig.push({ id: 'roas', text: `광고 효율이 ${k.adEfficiency}배로 기준(${snap.flags.adEfficiencyLowThreshold}배)보다 낮아요`, impact: k.sales * 0.1 });
    return sig.sort((a, b) => b.impact - a.impact).slice(0, 7);
  }

  async causeCandidates(user: AuthUser, reportId: number, metricKey?: string) {
    const r = await this.reportRow(user, reportId);
    const snap = r.data_snapshot;
    if (snap.kpis.delta.sales == null) throw new BadRequestException('비교할 이전 기간 자료가 없어서 원인 후보를 찾을 수 없어요.');
    const signals = await this.signals(snap);
    const dir = snap.kpis.delta.sales >= 0 ? '늘었' : '줄었';
    let source: 'gpt' | 'mock' = 'mock';
    let candidates: { title: string; explanation: string; signalIds: string[] }[] = [];
    let noteDraft = '';

    const g = await this.gpt(
      '당신은 쇼핑몰 운영 보고서의 원인 분석 도우미입니다. 아래 "signals" 중에서 매출 변화의 원인 후보를 최대 3개 고르세요. ' +
        'signals 에 없는 내용이나 숫자를 지어내지 마세요. 각 후보에는 근거가 되는 signal id 를 signalIds 로 넣고, 확정이 아닌 "후보"라는 말투로 쓰되, 모든 문장은 "~했을 수 있어요", "~후보예요"처럼 해요체로 끝내고 "~입니다"는 쓰지 마세요.' +
        '또 사용자가 고쳐 쓸 확인 메모 초안(noteDraft, 120자 이내, 해요체)도 쓰세요. ' +
        '출력 형식: {"candidates":[{"title":"짧은 제목","explanation":"한 문장 설명","signalIds":["..."]}],"noteDraft":"..."}',
      JSON.stringify({ metric: metricKey || 'sales', salesChange: `${snap.kpis.delta.sales}%`, direction: dir, signals }),
    );
    if (g && Array.isArray(g.candidates)) {
      const ids = new Set(signals.map((s) => s.id));
      const ok = g.candidates
        .filter((c: any) => Array.isArray(c.signalIds) && c.signalIds.length && c.signalIds.every((x: string) => ids.has(x)) && typeof c.title === 'string')
        .slice(0, 3)
        .map((c: any) => ({ title: String(c.title).slice(0, 40), explanation: String(c.explanation ?? '').slice(0, 140), signalIds: c.signalIds as string[] }));
      if (ok.length) {
        candidates = ok;
        noteDraft = String(g.noteDraft ?? '').slice(0, 150);
        source = 'gpt';
      }
    }
    if (!candidates.length) {
      candidates = signals.slice(0, 3).map((s) => ({ title: s.text.split(':')[0] + ' 변화', explanation: `${s.text}. 이것이 전체 ${dir}던 흐름에 영향을 줬을 수 있어요.`, signalIds: [s.id] }));
      noteDraft = `${signals[0]?.text ?? '이번 변화'}. 확인한 뒤 이유를 고쳐 써 주세요.`.slice(0, 150);
    }
    const byId = new Map(signals.map((s) => [s.id, s.text]));
    const out = {
      salesDelta: snap.kpis.delta.sales,
      candidates: candidates.map((c) => ({ title: c.title, explanation: c.explanation, evidence: c.signalIds.map((i) => byId.get(i)!).filter(Boolean) })),
      noteDraft,
    };
    const id = await this.save('cause_candidates', 'report', reportId, metricKey || 'sales', out, 'suggested', source, user);
    return { id, source, fallback: source === 'mock' && !!this.lastError, ...out };
  }

  // ---------- 3. 재고 소진 예측·발주 제안 (숫자는 시스템이 계산, 문장만 AI)
  async stockSuggestion(user: AuthUser, reportId: number) {
    const r = await this.reportRow(user, reportId);
    const alerts = ((r.data_snapshot.stockAlerts ?? []) as any[]).slice(0, 12);
    if (!alerts.length) return { id: null, source: 'mock', items: [], message: '확인이 필요한 재고가 없어요.' };

    const mock = (a: any) => stockSentence(a);
    let source: 'gpt' | 'mock' = 'mock';
    const sentences = new Map<number, string>();
    const g = await this.gpt(
      '당신은 재고 담당자를 돕는 도우미입니다. 아래 items 는 시스템이 이미 계산한 값입니다. 각 상품마다 해요체로 한 문장(80자 이내)을 쓰세요. ' +
        '문장에 숫자를 쓴다면 items 에 있는 값(qty, days, depletionDays, suggestOrderQty)만 쓰고 다른 숫자는 쓰지 마세요. 발주 수량은 바꾸지 마세요. ' +
        '출력 형식: {"items":[{"productId":숫자,"sentence":"..."}]}',
      JSON.stringify({ items: alerts.map((a) => ({ productId: a.productId, name: a.name, level: a.level, qty: a.qty, days: a.days, depletionDays: a.depletionDays, suggestOrderQty: a.suggestOrderQty })) }),
    );
    if (g && Array.isArray(g.items)) {
      for (const it of g.items) {
        const a = alerts.find((x) => x.productId === it.productId);
        if (!a || typeof it.sentence !== 'string') continue;
        const allowed = new Set(['0', '1', String(a.qty), String(a.days), String(a.depletionDays), String(Math.round(a.days)), String(Math.ceil(a.days)), String(Math.floor(a.days)), String(a.suggestOrderQty)]);
        if (it.sentence.length <= 120 && numbersIn(it.sentence).every((n) => allowed.has(n))) {
          sentences.set(a.productId, it.sentence);
          source = 'gpt';
        }
      }
    }
    const items = alerts.map((a) => ({ productId: a.productId, name: a.name, level: a.level, qty: a.qty, days: a.days, depletionDays: a.depletionDays, suggestOrderQty: a.suggestOrderQty, sentence: sentences.get(a.productId) ?? mock(a) }));
    const id = await this.save('stock_suggestion', 'report', reportId, '', { items }, 'suggested', source, user);
    return { id, source, fallback: source === 'mock' && !!this.lastError, items };
  }

  // ---------- 4. 요약 문장 초안 (선택)
  async summary(user: AuthUser, reportId: number) {
    const r = await this.reportRow(user, reportId);
    if (r.status === 'published') throw new ConflictException('공개된 보고서의 요약은 바꿀 수 없어요.');
    const snap = r.data_snapshot;
    let source: 'gpt' | 'mock' = 'mock';
    let text = templateSummary(snap);
    const g = await this.gpt(
      '당신은 쇼핑몰 보고서의 요약을 쓰는 도우미입니다. 아래 숫자만 사용해서 해요체로 2~3문장(200자 이내) 요약을 쓰세요. 숫자를 지어내거나 계산하지 마세요. ' +
        '기간은 basisWord 라는 말로 부르세요. (예: 어제, 지난주, 지난달) "오늘"이라고 쓰지 마세요. 출력 형식: {"text":"..."}',
      JSON.stringify({
        basisWord: snap.meta.type === 'daily' ? '어제' : snap.meta.type === 'weekly' ? '지난주' : '지난달',
        kpis: snap.kpis,
        stockSummary: snap.stockSummary,
        topProducts: snap.topProducts.slice(0, 3).map((p: any) => p.name),
        issues: snap.issues,
      }),
    );
    if (g && typeof g.text === 'string' && g.text.trim().length >= 10) {
      text = g.text.trim().slice(0, 400);
      source = 'gpt';
    }
    const id = await this.save('summary', 'report', reportId, '', { text }, 'suggested', source, user);
    return { id, source, fallback: source === 'mock' && !!this.lastError, text };
  }

  async history(user: AuthUser, kind?: string, limit = 30) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (user.role !== 'admin' && user.role !== 'superadmin') {
      params.push(user.id);
      where.push(`s.requested_by = $${params.length}`);
    }
    if (kind) {
      params.push(kind);
      where.push(`s.kind = $${params.length}`);
    }
    params.push(Math.min(Math.max(limit, 1), 100));
    return this.db.query(
      `SELECT s.id, s.kind, s.target_type, s.target_id, s.request_text, s.status, s.source, s.created_at, u.name AS requested_by_name, s.output
       FROM ai_suggestions s LEFT JOIN users u ON u.id = s.requested_by
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY s.id DESC LIMIT $${params.length}`,
      params,
    );
  }
}

@Controller('ai')
@Roles('user', 'admin')
export class AiController {
  constructor(private readonly ai: AiService) {}

  @Get('status')
  status() {
    return this.ai.status();
  }

  @Get('history')
  history(@CurrentUser() u: AuthUser, @Query('kind') kind?: string, @Query('limit') limit?: string) {
    return this.ai.history(u, kind, Number(limit) || 30);
  }

  @Post('template-change')
  templateChange(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.ai.templateChange(u, b?.templateCode, b?.request);
  }

  @Post('template-change/:id/apply')
  apply(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ai.applyTemplateChange(u, Number(id));
  }

  @Post('cause-candidates')
  cause(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.ai.causeCandidates(u, Number(b?.reportId), b?.metricKey);
  }

  @Post('stock-suggestions')
  stock(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.ai.stockSuggestion(u, Number(b?.reportId));
  }

  @Post('summary')
  summary(@CurrentUser() u: AuthUser, @Body() b: any) {
    return this.ai.summary(u, Number(b?.reportId));
  }

  @Post(':id/ignore')
  ignore(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ai.ignore(u, Number(id));
  }

  @Post(':id/used')
  used(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    return this.ai.markUsed(u, Number(id));
  }
}
