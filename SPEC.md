# 统一临床试验检索 MCP 服务 — 技术规格说明书（SPEC）

- **状态**：待评审；本文件获批准前不得进入实现
- **版本**：0.1.0-draft
- **日期**：2026-03-13
- **服务名**：`unified-trial-mcp`
- **部署形态**：单一 Node.js ≥22.13 的 stdio MCP Server
- **新环境策略**：单入口 + `doctor` + 显式 `bootstrap`；用户只向 MCP Client 注册本服务。

## 1. 目标与范围

### 1.1 目标

将现有临床试验检索能力统一成一个可被 MCP Client 调用的本地服务。服务向调用方提供一致的检索、详情、证据、来源状态与维护工具；对异构来源的参数、返回格式、缓存/索引范围、错误、超时与数据新鲜度进行显式规范化。

服务的首要正确性原则是**结果诚实性**：来源未配置、未查询、被拒绝、人机验证、超时、上游不完整、归档过期或本地索引未覆盖均不得折算为“0 条结果”。

### 1.2 首版包含

| 渠道/资产 | 首版接入方式 | 角色 | 检索时副作用 |
|---|---|---|---|
| WHO ICTRP | `ictrp-mcp-service` MCP adapter | 全球聚合补充 | 无；默认读取缓存/已下载 bundle |
| ClinicalTrials.gov | `ctv-mcp-server` MCP adapter | CT.gov 本地索引和详情 | 无；仅查询现有 SQLite/FTS 索引 |
| ChiCTR online | `chictr_trials` MCP adapter | 中国临床研究的在线验证/补缺 | 无；调用现有服务缓存与合规访问链路 |
| ChiCTR 胰腺癌语料 | 只读 SQLite adapter，读取 `chictr_trials/data/chictr_pancreatic.db` | 稳定的胰腺癌专题离线检索 | 无 |
| ChinaDrugTrials | 受控 scraper/archive adapter | 中国药物临床试验主渠道 | 无；只读既有归档，不能在查询中刷新 |
| XYB ChinaDrugTrials 数据包 | 只读 archive adapter，读取 `xyb-chinadrugtrials-data/output/` | 已归档的中国药物试验数据 | 无 |

### 1.3 首版不包含

- 远程 HTTP 共享服务、用户认证、多租户与 Web UI。
- 在 `search_trials`、`get_trial_detail` 或 `get_record_evidence` 内隐式抓取、同步或刷新任何上游。
- 将各来源 ETL 到一个新的一体化数据库。
- 医疗建议、患者匹配评分、纳排标准自动判定或试验真实性判断。
- 绕过 Cookie、访问控制、robots、WAF、验证码或其他反自动化机制。
- 基于标题或语义相似度的自动跨来源合并。

## 2. 使用者、成功标准与约束

### 2.1 使用者

- MCP Client、桌面端 AI 助手及临床研究支持工作流。
- 维护者：负责本地索引同步、归档更新、合法会话配置及来源运行时健康。

### 2.2 验收成功标准

1. 一个 MCP Server 能发现并调用第 4 节定义的 7 个工具。
2. `search_trials` 对启用来源执行有界并发检索，返回固定 JSON contract、来源级终态、覆盖与完整性信息。
3. 无论任何来源失败，其他来源仍可返回；每个注册来源在响应中都有终态。
4. 仅依可靠跨来源登记号或显式映射合并候选记录；不能证明同一记录时必须保留为独立记录。
5. 所有记录可追溯至来源、稳定身份、来源 URL、采集/索引时间与证据引用。
6. 搜索、详情和证据工具不触发联网刷新或修改归档/索引。
7. 维护工具必须显式调用、报告状态和变更摘要，且不会由查询工具调用。
8. 新环境用户只需在 MCP Client 中注册 `unified-trial-mcp`；`doctor` 能逐来源报告运行时、依赖、数据路径、索引新鲜度和合法会话的就绪状态，`bootstrap` 能在用户显式调用下批量准备公开依赖和本地资产。
9. `bootstrap` 不得自动获取 Cookie、秘密、受控数据或绕过 WAF/访问限制；任何需人工合规前置条件的来源必须明确报告。对于需要会话的来源（ChinaDrugTrials），新环境必须能够通过**显式一次性**命令自动取得（`configure --cookie-from-entry-page`，一次公开入口页 GET + 只读实测校验），或由服务明确引导用户手工配合取得（`configure --cookie-from-curl`）；二者不得都缺失，且 `doctor`/`bootstrap` 自身绝不自动获取。
10. 存在 PII 的公开原始资料按本次确认默认原样可返回，但服务记录来源与访问时间；调用方应遵守来源条款及适用法律，且不得将公开可访问错误理解为可无限制再分发。

### 2.3 非功能约束

- Node.js ≥22.13，ESM TypeScript；stdio JSON-RPC MCP transport。
  下限由 `node:sqlite`（ChiCTR 语料适配器）决定；该模块缺失时该来源报 `NEEDS_SETUP`，不影响其余来源。
- 默认本地运行，不开放监听端口。
- 所有 adapter 以显式超时、取消信号和结果上限运行。
- 输出必须可 JSON 序列化；不得以自由文本代替来源状态机。
- 日志不得含 Cookie、会话 token 或其他秘密；凭据只可从环境变量或受限本地配置读取。

## 3. 架构

```text
MCP Client
  │ stdio / JSON-RPC
  ▼
Unified Trial MCP (Node.js)
  ├─ Tool layer: 输入校验、MCP schema、维护操作显式门控
  ├─ Orchestrator: query 规范化、调度、取消、超时、状态终态化
  ├─ Normalizer: 来源结果解封装、canonical record 映射、证据引用
  ├─ Merger: 可靠身份候选归并、来源优先级、冲突保留
  ├─ Closed source registry: 来源描述符、启用状态、argShape、limits、freshness
  └─ Adapters
       ├─ ICTRP MCP
       ├─ CTV MCP / local index
       ├─ ChiCTR online MCP
       ├─ ChiCTR pancreatic SQLite corpus
       ├─ ChinaDrugTrials controlled archive/scraper
       └─ XYB ChinaDrugTrials archive
```

### 3.1 分层职责

| 层 | 责任 | 禁止事项 |
|---|---|---|
| Tool layer | JSON schema 校验、调用编排、返回 MCP content | 直接拼接来源专用参数或绕过注册表 |
| Orchestrator | 有界并发、总 deadline、取消、状态终态化 | 将异常或未知返回转为零结果 |
| Registry | 唯一来源身份、默认启用、参数映射、超时、新鲜度与能力声明 | 由 LLM/请求参数动态注册来源或指定命令/URL |
| Adapter | 调用一种上游/本地资产、解包与最小来源标准化 | 跨来源去重、修改全局状态、隐式刷新 |
| Normalizer/Merger | canonical 映射、证据、保守去重、确定性排序 | 以标题相似度断言同一试验 |
| Maintenance | 受控刷新与同步、摘要输出 | 被检索/详情工具隐式调用 |

### 3.2 封闭渠道注册表

渠道由宿主静态注册。每个 `SourceDescriptor` 至少包括：

```ts
interface SourceDescriptor {
  id: 'ictrp' | 'ctv' | 'chictr_online' | 'chictr_pancreatic_archive' | 'chinadrugtrials' | 'xyb_chinadrugtrials_archive';
  label: string;
  kind: 'mcp' | 'sqlite' | 'archive' | 'controlled_scraper';
  enabledByDefault: boolean;
  queryTimeoutMs: number;
  maxResults: number;
  argShape: (query: CanonicalQuery) => unknown;
  freshness: 'cached_network' | 'local_index' | 'offline_archive' | 'controlled_session_archive';
  supportsDetail: boolean;
  supportsEvidence: boolean;
  supportsMaintenance: boolean;
  identityRule: string;
  zeroResultMeaning: string;
}
```

请求只能提交检索条件、分页、显式来源筛选与结果限制；不得提交工具名、可执行命令、URL、超时或原始 adapter 参数。

### 3.3 调度

- 默认只查询 registry 中启用且请求未排除的来源。
- 默认并发上限为 4；总墙钟 deadline 初始设为 75 秒，二者均作为配置项并在实现测试中固定。
- 按预估耗时从长到短启动，保证 ICTRP 等慢来源不会因队列耗尽而从未启动。
- deadline 前未启动的来源为 `NOT_QUERIED / OVERALL_DEADLINE`；已启动却超时的来源为 `TIMEOUT`。
- 输出来源顺序必须遵循 registry 顺序，记录排序必须确定性。
- 每个 adapter 必须接受 `AbortSignal`，但取消失败也不得阻断响应回收。

## 4. MCP 工具契约

### 4.1 CLI 安装与初始化命令

统一服务的 npm package / 可执行入口为 `unified-trial-mcp`。新环境不要求用户预先部署或在 MCP Client 中分别注册五个服务；MCP Client 仅配置该一个 stdio command。可执行入口提供以下**显式**管理命令，它们不是 MCP 检索工具，不能由查询工具隐式调用：

```bash
# 只读环境与来源诊断；退出码：0=可用、1=存在可修复问题、2=严重配置错误
unified-trial-mcp doctor [--sources <comma-separated-source-ids>] [--json]

# 用户确认后批量准备公开运行依赖、受控 sidecar、本地目录和可选公开初始索引；默认 dry-run
unified-trial-mcp bootstrap [--sources <comma-separated-source-ids>] [--apply] [--with-ctv-index] [--json]

# 将已有的离线资产配置为只读挂载；仅写入本服务配置，不复制或改写源数据
unified-trial-mcp configure \
  --xyb-archive <absolute-output-dir> \
  --chictr-corpus <absolute-sqlite-path>

# 获取公开发布的离线语料（ADR-008）；默认 dry-run，--apply 才下载
unified-trial-mcp fetch-corpus --corpus chictr_pancreatic \
  [--url <https URL | file:// 绝对路径>] [--dest <绝对目录>] \
  [--apply] [--print-url] [--json]

# ChinaDrugTrials 会话取得的两种显式方式（任选其一；doctor/bootstrap 绝不自动调用）
unified-trial-mcp configure --cookie-from-entry-page [--cookie-check-keyword <关键词>]
unified-trial-mcp configure --cookie-from-curl '<浏览器「复制为 cURL」的完整命令>'
```

`doctor` 对 registry 的每个来源检查 Node/Python 版本、MCP/sidecar 可执行性、SQLite/归档 allowlisted 路径可读性、配置与索引/归档时间；只报告 ChinaDrugTrials 合法 Cookie 的“已配置/缺失/失效”状态，绝不显示其值；当该 Cookie 缺失或失效时，必须打印可复制的下一条取得命令（见 §4.1）。`bootstrap` 默认 `dry-run`，仅在 `--apply` 时安装 package 锁定版本的公开依赖、创建服务工作目录、初始化/校验本地资产；不得自动获取需要凭证、需绕过 robots/WAF/验证码、或需用户身份的数据（即 Cookie、秘密、受控归档），不写入 Cookie、不启动交互式浏览器；缺 Cookie 时同样只打印引导命令。**公开发布、可匿名下载的离线语料**按 ADR-008 由 `fetch-corpus` 步骤获取（同样默认 dry-run，`--apply` 才下载，且强制 sha256 校验）。失败需逐来源汇总，已成功的来源保持可用。

**ChinaDrugTrials 会话取得（`configure --cookie-from-entry-page` / `--cookie-from-curl`）**：新环境必须能够自动获得该会话，或由服务明确引导用户手工配合获得，二者不得都缺失。`--cookie-from-entry-page` 发起**一次公开入口页 GET**，取用站点主动下发的匿名反爬票据（`FSSBBIl1UgzbN7N80S`/`...T`），随后以 `--cookie-check-keyword`（默认 `胰腺癌`）发起一次只读检索**实测校验**，通过后才写入 `<configDir>/cookie.env`（0600）。这是正常访问而非绕过：不解验证码、不破挑战、不规避限流、不使用登录凭证伪造。`--cookie-from-curl` 为人工兜底，从浏览器「复制为 cURL」中提取 Cookie。两者均为**显式一次性**命令，`doctor`/`bootstrap` 绝不调用；服务不读取其他项目的配置文件或浏览器 Profile。Cookie 优先级：真实环境变量 > `cookie.env`；缺失时视为未配置，绝不凭空产生凭证。

离线包为外部只读资产，不作为需要另行部署的 MCP：用户通过 `configure` 挂载 `xyb-chinadrugtrials-data/output/` 和 `chictr_pancreatic.db`。

**公开离线语料获取（`fetch-corpus`，ADR-008）**：ChiCTR 胰腺癌语料（`chictr_pancreatic.db` + `pancreatic_trials.json` + `html/`）由本仓库 GitHub Release 发布 tar.gz，`fetch-corpus --corpus chictr_pancreatic --apply` 负责下载、校验、解压并原子替换到目标目录。约束：①默认 dry-run，打印将访问的 URL、预期字节数与 sha256，`--apply` 才实际写入；②必须校验 sha256 与字节数，不匹配即失败并**保留原有数据完全不动**；③解压到临时目录、校验通过后才原子替换，绝不就地解压覆盖；④支持重试以应对网络中断，但重试不改变校验要求；⑤`--url` 可指向镜像或 `file://` 本地路径以支持内网；⑥该命令不是 MCP 工具，查询工具绝不隐式触发下载。XYB 归档目前不提供自动获取，仍由用户 `configure` 手工挂载。ChinaDrugTrials 只有用户自行按来源条款提供合法会话后才可通过 MCP `sync_chinadrugtrials` 维护；未准备时必须报告 `NEEDS_SETUP`，不得阻断其余来源。

### 4.2 `search_trials`

**用途**：跨启用渠道的只读统一检索。

**输入**：

```ts
{
  keyword?: string;
  keywords?: string[];
  condition?: string;
  terms?: string;
  status?: string[];
  phase?: string[];
  country?: string;
  isChina?: boolean;
  startDateFrom?: string; // YYYY-MM-DD
  startDateTo?: string;   // YYYY-MM-DD
  sourceIds?: SourceId[]; // 可选，必须为 registry 中的 id
  limit?: number;         // 1..200，默认 50
  offset?: number;        // >=0，默认 0
}
```

至少必须提供 `keyword/keywords` 或 `condition/terms` 中的一项。`sourceIds` 仅缩小 registry 范围，不能添加新来源。

**输出**：`UnifiedSearchResponse`（第 5 节）。

**副作用**：无。不得触发 `refresh_ictrp`、`sync_ctv_index` 或 `sync_chinadrugtrials`。

### 4.3 `get_trial_detail`

**用途**：按统一记录身份、来源身份或可靠登记号读取一个来源详情；若存在已验证的合并组，返回组成员的逐来源详情摘要。

**输入**：

```ts
{
  recordId?: string;              // canonical `source:id`
  sourceId?: SourceId;
  sourceRecordId?: string;
  registryNumber?: string;
  includeRawFields?: boolean;     // 默认 false
}
```

`recordId` 或 `{sourceId, sourceRecordId}` 必须存在。仅有 `registryNumber` 时，响应必须列出所有候选及歧义，不得任意选择一条。

**输出**：`UnifiedDetailResponse`。默认返回 canonical 字段、来源字段摘要、证据引用与 provenance。`includeRawFields=true` 可返回公开的原始字段（含来源公开 PII），同时返回使用提示。

**副作用**：无。

### 4.4 `get_record_evidence`

**用途**：定位可审计的原始证据，不创建或下载证据。

**输入**：

```ts
{
  recordId: string;
  sourceId?: SourceId;
  evidenceKinds?: ('raw_html' | 'source_json' | 'source_word' | 'raw_text' | 'field_excerpt')[];
  maxExcerptChars?: number; // 0..12000，默认 4000
}
```

**输出**：来源 URL、相对/绝对受控文件引用、内容 hash、采集时间、可选片段和不可用原因。文件路径只可指向 registry 配置的允许根目录。

**副作用**：无；不下载、不解压、不刷新。

### 4.5 `get_source_status`

**用途**：返回每个注册来源的启用/可用情况、索引/归档时间、覆盖范围、运行时依赖和建议修复动作。

**输入**：

```ts
{ sourceIds?: SourceId[]; includeDiagnostics?: boolean }
```

**输出**：`SourceStatus[]`；运行时检查必须有短超时，检查失败返回诊断状态，而非让整个工具失败。

### 4.6 `refresh_ictrp`

**用途**：显式刷新 ICTRP 缓存或 bundle。

**输入**：`{ force?: boolean }`。

**输出**：刷新前后元数据、开始/结束时间、成功/失败、上游返回总数、完整性警告。若上游拒绝、挑战或不可用，返回来源终态。

### 4.7 `sync_ctv_index`

**用途**：显式更新 CTV 本地索引；不运行在线 study-search 爬取。

**输入**：

```ts
{ mode?: 'csv_import' | 'sitemap_sync' | 'detail_backfill'; maxShards?: number; maxRecords?: number }
```

限制：`maxShards` 为 1..60；同步时遵守原服务的 RPS=2、并发=3、20 秒单请求超时与 robots 约束。

### 4.8 `sync_chinadrugtrials`

**用途**：在合法、已配置的 Cookie 会话下显式对 ChinaDrugTrials 进行增量归档；此工具不尝试登录或绕过任何控制。

**输入**：

```ts
{
  keywords: string[];
  maxPages?: number;
  delaySeconds?: number; // 默认 1.5
  incremental?: boolean; // 默认 true
  filters?: Record<string, string | string[]>;
}
```

**输出**：每关键词的页面数、记录数、变更数、未变更 skip 数、失败数、证据产物根目录、开始/结束时间与失败原因。Cookie 不得出现在日志、工具响应或错误信息中。

## 5. 统一响应和数据模型

### 5.1 来源终态

```ts
type SourceState =
  | 'SUCCESS'
  | 'NO_RESULTS'
  | 'NOT_ENABLED'
  | 'NEEDS_SETUP'
  | 'NOT_QUERIED'
  | 'TIMEOUT'
  | 'CHALLENGE_REQUIRED'
  | 'RATE_LIMITED'
  | 'DENIED'
  | 'FAILED';
```

只有 `SUCCESS` 和 `NO_RESULTS` 表示来源实际完成了查询。每项状态至少有 `reasonCode`、`explanation`、`attempted`、`elapsedMs`；可修复时有 `fixHint`。

### 5.2 `SourceConclusion`

```ts
interface SourceConclusion {
  sourceId: SourceId;
  sourceLabel: string;
  state: SourceState;
  reasonCode: string;
  explanation: string;
  attempted: boolean;
  elapsedMs: number;
  resultCount?: number;
  requestedLimit?: number;
  truncated?: boolean;
  freshness: {
    kind: 'cached_network' | 'local_index' | 'offline_archive' | 'controlled_session_archive';
    retrievedAt?: string;
    indexedAt?: string;
    scrapedAt?: string;
    staleAfterDays?: number;
    stale?: boolean;
  };
  coverage: {
    scope: string;
    zeroResultMeaning: string;
    indexOrArchiveOnly: boolean;
  };
  completeness: {
    isLowerBound: boolean;
    upstreamReportedTotal?: number;
    rowsReturned?: number;
    recordsIncomplete?: boolean;
    warnings: string[];
  };
  fixHint?: string;
}
```

### 5.3 `CanonicalTrialRecord`

```ts
interface CanonicalTrialRecord {
  recordId: string; // `${sourceId}:${sourceRecordId}`，不可变
  source: { id: SourceId; label: string; sourceRecordId: string };
  registryNumbers: Array<{ registry: string; value: string; primary?: boolean }>;
  title?: string;
  publicTitle?: string;
  conditionOrDisease?: string[];
  interventions?: string[];
  studyType?: string;
  recruitmentStatus?: string;
  phase?: string[];
  sponsorOrInstitution?: string[];
  countries?: string[];
  dates?: { registered?: string; started?: string; updated?: string; completed?: string };
  sourceUrl?: string;
  provenance: {
    retrievedAt?: string;
    indexedAt?: string;
    scrapedAt?: string;
    contentHash?: string;
    rawEvidenceRefs: EvidenceRef[];
    piiLevel: 'public_source_may_contain_pii' | 'none_known';
  };
  mergedFrom?: string[];
  sourceLabels?: string[];
  perSource?: Array<{ recordId: string; sourceId: SourceId; sourceRecordId: string }>;
}
```

**身份规则**：

- 原始主键始终是 `{source_registry, source_record_id}`。
- ChinaDrugTrials 使用 `reg_no`；ChiCTR 使用 `project_id`，保留可空的 `registration_number`；CTV 使用服务暴露的稳定 study ID/slug；ICTRP 使用 `registry + primary ID`。
- 仅在规范化后相同的可靠登记号或维护的显式跨来源映射存在时创建合并组。
- 标题、机构、疾病、干预、日期相似都只能用于排序/提示，不可作为自动合并依据。
- 合并结果保留全部来源成员、每来源字段和冲突，不覆盖原始值。

### 5.4 `UnifiedSearchResponse`

```ts
interface UnifiedSearchResponse {
  schemaVersion: '1.0';
  query: CanonicalQuery;
  statuses: SourceConclusion[];
  coverage: { queried: SourceId[]; unavailable: SourceId[]; notQueried: SourceId[] };
  completeness: { isComplete: boolean; warnings: string[] };
  totalRecords: number;
  records: CanonicalTrialRecord[];
  overlaps: Array<{ registryNumber: string; recordIds: string[]; mergeApplied: boolean }>;
  startedAt: string;
  elapsedMs: number;
  cancelled: boolean;
  disclaimer: string;
}
```

`totalRecords` 是本响应中已规范化/合并记录数，不等同全网结果总数。对分页来源，adapter 必须说明是来源总数、已读取数还是下界。

## 6. 渠道适配契约

### 6.1 共用 adapter 接口

```ts
interface TrialSourceAdapter {
  readonly descriptor: SourceDescriptor;
  search(query: CanonicalQuery, ctx: AdapterContext): Promise<AdapterSearchResult>;
  getDetail?(id: string, ctx: AdapterContext): Promise<AdapterDetailResult>;
  getEvidence?(id: string, request: EvidenceRequest, ctx: AdapterContext): Promise<AdapterEvidenceResult>;
  getStatus(ctx: AdapterContext): Promise<SourceStatus>;
  maintain?(request: MaintenanceRequest, ctx: AdapterContext): Promise<MaintenanceResult>;
}
```

`AdapterSearchResult` 必须提供原始记录、来源总数/截断信息、时间/索引元数据与错误分类。未知 envelope、JSON 解析失败或缺失关键字段必须为 `FAILED / UNRECOGNISED_ENVELOPE`，不得成为空数组。

### 6.2 来源专用要求

| 来源 | 身份/关键字段 | 特有完整性与风险要求 |
|---|---|---|
| ICTRP | registry + primary ID | 原样保留 `rows_returned`、`upstream_reported_total`、`records_incomplete`；ICTRP 成功结果仍可能为下界，尤其不得用其对中国专题作否定结论。 |
| CTV | 稳定 study ID/slug，保留 NCT/UTN | 搜索零结果仅代表本地 SQLite/FTS 索引未命中；详情 GraphQL 优于 CSV；CSV 字符问题须保留 warning。 |
| ChiCTR online | `project_id`，`registration_number` 可空 | WAF/短 Cookie/浏览器 fallback 失败须为 `CHALLENGE_REQUIRED` 或 `NEEDS_SETUP`；绝不绕过。 |
| ChiCTR pancreatic archive | SQLite `trials.project_id` | 限定为胰腺癌离线专题语料；必须在 `freshness.dataCutoff` 报告数据截止日（由语料内 `trials.updated_at` 与 `crawl_log` 推导，**不得硬编码**）、`cutoffSource` 与 `updateHint`，并保留专题 coverage；不宣称为全量 ChiCTR。 |
| ChinaDrugTrials | `reg_no` | 仅合法会话的显式同步可以更新；`details` 的扁平键不充分，审计优先使用 `sections`、原始 HTML、Word 与 hash。 |
| XYB ChinaDrugTrials archive | `reg_no` | 报告每个数据包 `summary.json` 的 query、页数、记录数和 scrape 时间；`freshness.dataCutoff` 取"记录级 `scrape_time` 与 summary 声明中的较新者"并声明 `cutoffSource` 的覆盖率，记录时间跨度过大时须显式 warning；检查未来时间，发现即 warning。 |

## 7. 错误、降级与安全

### 7.1 错误映射

| 情况 | 终态 | 行为 |
|---|---|---|
| 适配器成功且 0 条 | `NO_RESULTS` | 返回来源的零结果语义，不扩张为“没有试验” |
| 未启用 | `NOT_ENABLED` | 不调用来源 |
| 依赖、路径、Cookie 或本地索引缺失 | `NEEDS_SETUP` | 返回可操作的 `fixHint`，不泄露秘密 |
| 总 deadline 前未启动 | `NOT_QUERIED` | `OVERALL_DEADLINE` |
| 已启动超时 | `TIMEOUT` | 回收已完成来源 |
| WAF/验证码/挑战页 | `CHALLENGE_REQUIRED` | 明确不绕过 |
| 429 | `RATE_LIMITED` | 保留上游信息并建议稍后重试 |
| 权限拒绝 | `DENIED` | 不转为无结果 |
| 非预期上游/解析错误 | `FAILED` | 返回安全诊断，不影响其他来源 |

### 7.2 PII、凭据与证据

- 本次产品决策：公开来源可用的联系人 PII 默认不脱敏，`includeRawFields` 或 evidence 输出可以包含此类字段。
- 服务仍须在每个含原始字段的响应标注 `piiLevel` 与来源 URL；操作日志记录调用工具、来源、记录 ID、时间和是否请求 raw 字段。
- Cookie、token、认证 header、完整本地配置和系统环境变量绝不得进入工具返回、错误或普通日志。
- `get_record_evidence` 只能读取来源 descriptor 声明的 allowlisted 根目录，禁止请求传入任意文件路径。
- 原始 HTML、Word 和 JSON 的导出由调用者承担来源条款/隐私合规责任；服务不把它们自动写入通用 RAG。

## 8. 可观测性与运行配置

### 8.1 结构化日志与指标

每个工具调用和来源子调用写入结构化日志：`requestId`、工具、query hash（不记录完整敏感输入）、sourceId、状态、耗时、返回数、截断、freshness、错误码。维护工具额外记录变更数和产物路径。日志应支持按 requestId 关联，但不记录 Cookie/PII 字段正文。

最低运行指标：成功/失败率、来源状态分布、P50/P95 来源耗时、deadline 未启动次数、索引/归档年龄、合并/重叠数、维护变更与失败数。

### 8.2 配置

配置分为：

- **静态 registry 配置**：来源 ID、默认开关、超时、并发、允许根目录、能力、运行命令（维护限定）。
- **路径配置**：ICTRP bundle、CTV SQLite、ChiCTR SQLite、ChinaDrugTrials/XYB archive 根目录；启动时验证可读且在 allowlist 内。
- **秘密配置**：ChinaDrugTrials Cookie 等，仅从环境变量或权限受限文件读取；不可通过 MCP 参数写入。
- **维护限制**：最大 pages/shards/records、最小延迟、重试数和上游速率限制；均设安全默认值。

## 9. 测试与验收矩阵

| 层级 | 必测项目 |
|---|---|
| 单元 | query 规范化、`argShape`、状态终态化、MCP envelope 解包、身份规范化、仅可靠 ID 合并、确定性排序、PII/秘密日志剔除 |
| adapter contract | 每个 adapter 的成功、零结果、截断、超时、未知 envelope、缺少数据路径、过期/未来数据时间、证据路径越界 |
| 编排集成 | 4 并发与 75 秒 deadline、局部失败继续、未启动与已超时区别、取消、registry 顺序、来源筛选不能越权 |
| 工具集成 | 7 个工具 schema、无查询副作用、维护工具不被查询调用、错误 JSON contract、detail 歧义 registry number |
| 回归夹具 | ICTRP 不完整数据、CTV 本地索引零结果、ChiCTR `registration_number=NULL`、ChinaDrugTrials 嵌套 sections 优先、XYB 时间异常、PII 原始字段 |
| 手工验收 | 在无 Cookie、WAF challenge、缺 Python/Node sidecar、无本地 DB、过期 archive 下分别验证明确状态和 fixHint |
| 新环境会话取得 | 全新配置目录、**无任何环境变量**下：(a) `doctor` 必须打印两条确切取得命令；(b) `configure --cookie-from-entry-page` 自动取得并**实测校验**；(c) 写入 `cookie.env` 后 `doctor` 转 `SUCCESS`/退出码 0，且服务仅凭该文件即可完成真实检索；(d) `--cookie-from-curl` 能从 cURL 提取；(e) 获取失败时返回具体 reasonCode 与人工兜底引导；(f) `doctor`/`bootstrap` 全程不调用获取逻辑 |

通过标准：所有单元/集成测试通过；每个来源至少有一条 fixture 驱动的成功与失败路径；不存在把上述异常情形映射为 `NO_RESULTS` 的测试/实现；所有查询工具的文件系统变更为零。

## 10. 实施阶段（批准后）

1. 建立 Node/TypeScript MCP 骨架、配置加载、静态 registry、canonical types 与 fixture test harness。
2. 实现单入口 CLI：`doctor`、默认 dry-run 的 `bootstrap --apply`、`configure`、来源级诊断与受控配置写入。
3. 实现编排器、状态机、规范化/保守合并和 `search_trials` / `get_source_status`。
4. 实现三个 MCP adapter（ICTRP、CTV、ChiCTR online）及两个只读 SQLite/archive adapter。
5. 实现 ChinaDrugTrials/XYB archive、详情与证据查询，并建立路径 allowlist。
6. 实现三个显式维护 adapter/工具与操作日志。
7. 实现 `fetch-corpus`（ADR-008）与配套 `scripts/pack-corpus.mjs`：打包脚本产出 tar.gz + sha256 清单，CLI 负责下载/校验/原子替换，`bootstrap` 接入为可选步骤。
8. 完整测试、安装/配置文档和来源/数据合规操作手册。

阶段完成顺序不意味着可跳过测试；每阶段仅在上一步测试通过后进入。

## 11. 架构决策记录（ADR）

### ADR-001：采用单一 stdio MCP 编排服务

- **决定**：以 Node.js stdio MCP 作为统一入口，通过适配器整合各来源。
- **理由**：已确认 MCP-first；本地 stdio 避免首版引入网络认证/多租户运维；能适配现有 Node/Python MCP 和离线 SQLite/归档。
- **替代方案**：HTTP 服务（需新增认证/部署）；嵌入 Electron 宿主（强绑定单一桌面应用）；直接代理（无法统一语义）。
- **后果**：需为子进程/adapter 设置明确生命周期、超时和错误边界。

### ADR-002：静态封闭来源注册表

- **决定**：来源、工具映射、超时与允许路径由服务静态配置，调用请求不能决定任意 URL/命令/tool。
- **理由**：防止动态扩源绕开权限、审计、超时与契约；新增来源是受审查的 descriptor 变更。
- **替代方案**：请求携带任意来源；插件自注册。
- **后果**：新增渠道须改 registry 和测试，但行为可预测、可审计。

### ADR-003：查询与刷新严格分离

- **决定**：所有查询工具只读；ICTRP/CTV/ChinaDrugTrials 更新通过显式维护工具运行。
- **理由**：用户确认的策略；避免检索延迟、隐式网络副作用、反爬/限流风险和结果不可重现。
- **替代方案**：查询时刷新；按来源隐式刷新。
- **后果**：结果必须暴露索引/归档新鲜度，维护工作成为独立操作。

### ADR-004：保守身份与去重

- **决定**：以 `{source_registry, source_record_id}` 保存原始身份；仅可靠登记号或显式映射才合并。
- **理由**：ChiCTR registration number 可空，标题相似度会误合并不同试验；宁可展示重叠候选也不制造错误实体。
- **替代方案**：标题模糊去重；仅用登记号作为主键。
- **后果**：可能保留重复候选，UI/调用方需利用 `overlaps` 和 `perSource` 展示。

### ADR-005：来源级覆盖/完整性/新鲜度为一等字段

- **决定**：`SourceConclusion` 中固定输出 coverage、completeness、freshness 及状态。
- **理由**：ICTRP 有已知不完整、CTV 是本地索引、离线包可能过期；没有这些字段会把技术限制误导为临床否定结论。
- **替代方案**：仅返回 records 和总数；在自由文本 disclaimer 说明。
- **后果**：响应更大，但可审计且适合临床研究场景。

### ADR-006：新环境采用单入口、诊断与显式批处理初始化

- **决定**：MCP Client 只注册 `unified-trial-mcp`；通过 CLI `doctor` 诊断、显式 `bootstrap --apply` 批量准备公开依赖/本地资产、`configure` 只读挂载离线包，并以 `configure --cookie-from-entry-page`（自动，一次公开入口页 GET + 只读实测校验）或 `configure --cookie-from-curl`（人工兜底）取得 ChinaDrugTrials 会话。
- **理由**：用户不应手动部署并注册多个异构 MCP；显式 bootstrap 让下载、安装和本地初始化的副作用可预览、可审计、可失败恢复。会话取得同样必须显式、一次性、可校验，否则新环境要么无法使用该来源，要么只能依赖用户自行摸索。
- **替代方案**：安装时自动初始化（副作用和失败面大）；完全手工部署所有子服务（门槛高）；运行时按需隐式安装（不可预测）；`doctor`/`bootstrap` 自动取 Cookie（会把「一次公开访问」滑向「自动对抗封禁」，故排除）。
- **后果**：需维护锁定版本、幂等步骤、来源级诊断和清晰退出码；会话写入独立的 `cookie.env`（0600）而非 JSON 配置，保证配置文件始终无秘密；`doctor`/`bootstrap` 只引导不获取，且在诊断中必须给出确切的下一条命令。注意：本 ADR 的“不代为获取”特指**需要凭证、需要绕过 robots/WAF/验证码、或需要用户身份的数据**；公开发布且可匿名下载的离线语料按 ADR-008 处理。

### ADR-007：公开 PII 默认不脱敏，但强制可追溯与秘密隔离

- **决定**：按用户确认，公开来源的联系人资料默认可返回；仍标记 PII，记录访问元数据，且严禁泄露 Cookie/token。
- **理由**：满足既定使用偏好，同时避免“公开”被误认为没有再分发/审计责任。
- **替代方案**：默认脱敏；只有受控 evidence 返回。
- **后果**：调用方必须承担来源条款和适用数据法规遵从；测试必须验证秘密永不泄露。

### ADR-008：离线语料可经显式命令从固定 Release 获取

- **背景**：ADR-006 声明 bootstrap“绝不代替用户下载或分发第三方数据”。但 ChiCTR 胰腺癌语料（226 MB，压缩后 24.6 MB）若要求每个新环境用户手工寻找、下载、解压、再 `configure`，冷启动门槛过高，实践中会导致该来源在多数部署里永远不可用。这两个目标需要一条明确边界，而不是含糊妥协。
- **决定**：
  1. **边界按“是否需要突破访问控制”划分，而非按“是否联网”划分。** ADR-006 的禁令精确含义是：不代替用户获取需要凭证、需要绕过 robots/WAF/验证码、或需要用户身份的数据（ChinaDrugTrials 会话 Cookie、受控归档）。**公开发布、可匿名下载的语料**不在此列，可由本服务代为获取。
  2. 语料获取是**独立子命令** `fetch-corpus`，并作为 `bootstrap` 的一个步骤出现；它不被任何查询工具隐式触发，MCP 工具面（SPEC 第 4 节 7 个工具）完全不涉及下载。
  3. 内置默认 URL 指向本仓库的 GitHub Release；用户可用 `--url` 覆盖为镜像或本地文件路径（`file://`），以支持内网/离线机房。
  4. **完整性不可协商**：必须校验 sha256 与预期字节数，不匹配即失败并**保留原有数据不动**；解压到临时目录、校验通过后才原子替换目标目录，绝不就地解压覆盖。
  5. **可复现**：`scripts/pack-corpus.mjs` 生成 tar 包，同时输出 sha256 与尺寸清单；该清单随仓库提交，`fetch-corpus` 用它校验。
- **理由**：把“自动获取”限定在开放、可匿名、可校验的数据上，既保住了 ADR-006 真正想守住的底线（不代取凭证、不绕过防护），又让冷启动一次命令可达。sha256 + 原子替换保证“下载失败”永远表现为“维持原状”，而不是“半损坏的语料”。
- **替代方案**：随 npm 包分发（包体积和每次更新成本不可接受）；只给文档让用户手工处理（冷启动门槛过高，ADR-006 现状）；运行查询时按需隐式下载（不可预测、不可审计，且违反查询只读原则）。
- **后果**：
  - ADR-006 的措辞需相应收窄为“不代取需凭证/需突破防护的数据”，本 ADR 是其补充而非废止；两者共同构成完整规则。
  - 需维护 Release 资产与 sha256 清单的一致性；发布新语料时必须同步更新清单，否则 `fetch-corpus` 会拒绝。
  - README/文档必须标注语料来源、上游许可与再分发责任，用户可自行用 `--url` 指向自建镜像。
  - 下载过程需可中断恢复（重试）、可诊断（`doctor` 报告语料是否就绪、来源 URL、校验结果）。

## 12. 已知风险与缓解

| 风险 | 影响 | 缓解 |
|---|---|---|
| ICTRP 上游 CSV/查询结果不完整 | 漏检被误判 | 下界、upstream total、records incomplete 透传；禁止否定性结论 |
| ChiCTR WAF/短 Cookie/高依赖体积 | 在线查询不可用或脆弱 | 独立 adapter、挑战终态、离线胰腺癌 corpus 回退；不绕过 WAF |
| ChinaDrugTrials Cookie/网页变动 | 同步失败或解析漂移 | 合规 session、显式维护、重试/延迟、raw HTML + sections + hash 审计 |
| 本地离线归档过期/时间异常 | 时效错误；把"快照没收录"误读为"试验不存在" | `freshness.dataCutoff` + `cutoffSource` + `updateHint` 三者齐备并在 `search_trials`/`get_source_status` 同时可见；截止日由数据推导不得硬编码；记录跨度大时显式 warning；future timestamp/不一致警告 |
| 语料 Release 资产与仓库中的 sha256 清单不一致 | 新环境冷启动下载被拒，或（若跳过校验）装入损坏/被替换的语料 | `fetch-corpus` 强制校验 sha256 + 字节数，不匹配即失败并保留原有数据；打包脚本与清单同一次提交更新；CI 校验清单格式与资产可下载性 |
| 自动下载被视为本服务再分发第三方数据 | 许可与合规风险 | ADR-008 边界：只自动获取公开可匿名下载的语料；README/文档标注来源与许可；用户可 `--url` 指向自建镜像；`fetch-corpus` 打印来源 URL 与校验值供审计 |
| 离线快照无人更新 | 快照逐渐失效 | 明示社区共同维护、报告截止日与更新命令（`configure --xyb-archive` / `configure --chictr-corpus`）、`doctor` 输出可见；`staleAfterDays` 超期提示 |
| 多来源重复/冲突 | 错误合并 | source 原始身份、可靠 ID 合并、保留 `overlaps`/`perSource` |
| PII/原始证据再分发 | 合规/隐私风险 | 来源标记、访问日志、allowlist、秘密隔离、操作手册 |
| 子进程/MCP 版本不兼容 | 某渠道不能工作 | `doctor` 运行时健康检查、`NEEDS_SETUP`、锁定 bootstrap 依赖版本、固定 adapter contract fixtures |
| 新环境初始化中断或部分失败 | 部分来源不可用、用户不知如何修复 | 默认 dry-run、`--apply` 显式确认、幂等 bootstrap、逐来源结果和退出码；已就绪来源不回滚或破坏 |

## 13. 参考调研依据

- 整合模式、来源状态/覆盖度/完整性、受控注册表和扇出：`/Users/qinxiaoqiang/Downloads/xiaoyibao-pi-desktop-fix-records-audit/docs/spec/xyb-unified-trial-host-orchestration.md`，以及 `apps/desktop/electron/main/trial-sources.ts`、`trial-fanout.ts`、`trial-orchestrator.ts`。
- ICTRP MCP 工具与不完整性约束：`/Users/qinxiaoqiang/Downloads/ictrp-mcp-service/README.md`、`src/ictrp_mcp/server.py`。
- ChinaDrugTrials 合规 scraper 与归档 schema：`/Users/qinxiaoqiang/Downloads/chinadrugtrials/README.md`、`scraper.py`、`config.example.json`。
- XYB 离线归档事实与时间异常：`/Users/qinxiaoqiang/Downloads/xyb-chinadrugtrials-data/output/胰腺癌/summary.json`、`json/CTR20244170.json`。
- CTV MCP/local SQLite/GraphQL 约束：`/Users/qinxiaoqiang/Downloads/ctv-mcp-server/README.md`、`src/index.ts`、`src/config.ts`。
- ChiCTR MCP、sidecar 与胰腺癌 SQLite corpus：`/Users/qinxiaoqiang/Downloads/chictr_trials/README.md`、`src/index.ts`、`src/runtime/cache-manager.ts`、`tools/chictr_crawl.py`、`data/chictr_pancreatic.db`。
