/**
 * MCP tool schemas (SPEC 4).
 *
 * The schemas are deliberately closed: no source URL, tool name, timeout,
 * secret, or filesystem path is ever accepted from a caller. Source selection
 * is an enum over the registry; everything else comes from config.
 */

import { getDescriptor, SOURCE_IDS } from '../core/registry.js';

const SOURCE_ENUM = SOURCE_IDS.map((id) => {
  const descriptor = getDescriptor(id);
  return {
    const: id,
    title: descriptor.label,
    description: descriptor.scope,
  };
});

export interface ToolSchema {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const sourceIdsProperty = {
  type: 'array',
  description: '限定检索来源；不传表示使用所有已启用来源。未注册的来源会被拒绝，而不是静默忽略。',
  items: { anyOf: SOURCE_ENUM },
  uniqueItems: true,
};

export const TOOL_SCHEMAS: ToolSchema[] = [
  {
    name: 'search_trials',
    title: '统一临床试验检索',
    description:
      '在多个已配置来源中检索临床试验并合并结果。响应包含每个来源的终态（statuses）与覆盖状况（coverage）：' +
      '只有 SUCCESS/NO_RESULTS 的来源才算真正查询过；其它状态的缺失不得解读为“不存在相关试验”。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '自由文本关键词（疾病、药物、方案名等）。' },
        keywords: { type: 'array', items: { type: 'string' }, description: '多个关键词；与 keyword 合并使用。' },
        condition: { type: 'string', description: '适应症/疾病，映射到各来源的条件字段。' },
        terms: { type: 'string', description: '检索表达式；当各来源需要不同字段时与 keyword 并用。' },
        status: { type: 'array', items: { type: 'string' }, description: '招募状态筛选（各来源取值不同，未匹配的来源将按其自身语义返回）。' },
        phase: { type: 'array', items: { type: 'string' }, description: '试验分期筛选。' },
        country: { type: 'string', description: '国家/地区筛选。' },
        isChina: { type: 'boolean', description: '仅保留有中国站点的试验（CTV 等支持该语义的来源）。' },
        startDateFrom: { type: 'string', description: '起始日期下限（YYYY-MM-DD）。' },
        startDateTo: { type: 'string', description: '起始日期上限（YYYY-MM-DD）。' },
        sourceIds: sourceIdsProperty,
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 20, description: '每个来源返回的最大记录数。' },
        offset: { type: 'integer', minimum: 0, default: 0, description: '分页偏移（按来源各自分页，非全局分页）。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'get_trial_detail',
    title: '单条试验详情',
    description: '按 recordId（"<来源>:<来源记录号>"）返回单一来源的单条记录详情与原始字段。',
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '来自 search_trials 的 recordId，例如 chictr_pancreatic_archive:34440。' },
      },
      required: ['recordId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_record_evidence',
    title: '原始证据',
    description:
      '返回某条记录的原始证据引用（原始 HTML、源 JSON、Word、字段摘录）。路径均在配置允许的根目录之内，' +
      '不接受调用方传入的任意路径。',
    inputSchema: {
      type: 'object',
      properties: {
        recordId: { type: 'string', description: '来自 search_trials 的 recordId。' },
        evidenceKinds: {
          type: 'array',
          items: { enum: ['raw_html', 'source_json', 'source_word', 'raw_text', 'field_excerpt'] },
          description: '期望的证据类型；来源不支持时返回明确的不可用原因。',
        },
        maxExcerptChars: { type: 'integer', minimum: 1, maximum: 20000, description: '摘录最大字符数。' },
      },
      required: ['recordId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_source_status',
    title: '来源状态诊断',
    description:
      '返回每个来源的就绪状态与数据依赖情况，不发起检索。SUCCESS 表示入口与数据就绪，不代表该来源包含目标试验。',
    inputSchema: {
      type: 'object',
      properties: {
        sourceIds: sourceIdsProperty,
        includeDiagnostics: { type: 'boolean', default: false, description: '包含路径、条目数等诊断细节。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'refresh_ictrp',
    title: '刷新 ICTRP 缓存',
    description: '显式刷新 WHO ICTRP 导出缓存。默认为演练（dry run），需显式 apply=true 才会执行。',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', default: false, description: '为 true 才真正执行；默认只返回演练计划。' },
        force: { type: 'boolean', default: false, description: '忽略上游缓存新鲜度，强制刷新。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_ctv_index',
    title: '同步 CTV 本地索引',
    description: '显式构建/更新 CTV（Veeva）本地索引。默认为演练，需显式 apply=true 才会执行。',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', default: false, description: '为 true 才真正执行；默认只返回演练计划。' },
        mode: { enum: ['sitemap_sync', 'csv_import', 'detail_backfill'], description: '同步模式。' },
        maxShards: { type: 'integer', minimum: 1, description: '最大分片/批次数。' },
        maxRecords: { type: 'integer', minimum: 1, description: '最大记录数。' },
        incremental: { type: 'boolean', default: true, description: '是否增量同步。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
  {
    name: 'sync_chinadrugtrials',
    title: '同步 ChinaDrugTrials 归档',
    description:
      '按关键词增量同步 ChinaDrugTrials 列表数据到已配置的归档目录。需要人工配置的合法会话 Cookie；' +
      '本服务不会自动获取 Cookie、不会绕过验证码或 WAF。默认为演练，需显式 apply=true 且提供 keyword。',
    inputSchema: {
      type: 'object',
      properties: {
        apply: { type: 'boolean', default: false, description: '为 true 才真正抓取；默认只返回演练计划。' },
        action: { const: 'sync', description: '维护动作；该来源仅支持 sync。缺省即 sync。' },
        keyword: { type: 'string', description: '同步关键词；受控来源不支持全量抓取，必须提供。' },
        maxPages: { type: 'integer', minimum: 1, maximum: 10, default: 1, description: '最多抓取的列表页数（每页 20 条）。' },
      },
      required: [],
      additionalProperties: false,
    },
  },
];
