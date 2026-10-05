# 来源与数据合规操作手册

本文件是 [SPEC.md](../SPEC.md) §10 阶段 7 的交付物，面向**维护者**。它说明每个来源的法律/条款边界、数据路径、新鲜度、失效诊断与处置步骤。

## 0. 三条不可逾越的红线

1. **不绕过任何访问控制**：Cookie、登录、robots、WAF、验证码、限流一律不绕。触发验证时状态为 `CHALLENGE_REQUIRED`，需要人工在合法浏览器中完成验证。
2. **服务不自动获取秘密或受控数据**：Cookie 仅在用户显式执行 `configure --cookie-from-entry-page`／`--cookie-from-curl` 时才被获取并写入 `cookie.env`（0600）；`doctor`／`bootstrap` 绝不自动获取，只在缺失时打印下一条确切命令。服务不登录、不启动交互式浏览器、不下载浏览器运行时、不读取其他项目的配置文件或浏览器 Profile。
   - **边界说明**：`--cookie-from-entry-page` 发起的是**一次公开入口页 GET**。站点在该页主动下发两个匿名反爬票据，取用它们等价于一次正常访问——不解验证码、不破挑战、不规避限流。这与「击败访问控制」有本质区别，后者永不做。
3. **不把“没查到”说成“不存在”**：来源未配置、失败、超时、验证、限流、索引未覆盖、上游不完整，一律显式报告，绝不折算为 0 条结果。

## 1. 数据资产一览

| 资产 | 路径（本机已验证） | 大小/规模 | 只读？ |
|---|---|---|---|
| ChiCTR 胰腺癌语料 | `<home>/Downloads/chictr_trials/data/chictr_pancreatic.db` | 468 条，153,878,528 bytes | 只读（`readOnly: true`） |
| XYB ChinaDrugTrials 数据包 | `<home>/Downloads/xyb-chinadrugtrials-data/output` | `胰腺癌` 包 139 条 | 只读 |
| ICTRP bundle | `<home>/Downloads/ictrp-mcp-service` | 上游缓存 | 只读（维护工具可刷新） |
| CTV 本地索引 | `~/.ctv-mcp/ctv.db`（默认） | 已验证 1434 条 | 查询只读；维护工具可写 |
| ChinaDrugTrials 归档 | 由 `--chinadrugtrials-archive` 指定 | 按采集 | 查询只读；`sync` 可写 |
| ChiCTR online | 上游 `.cache` | 非语料库 | 只读 |

### 1.1 XYB 数据包的实际内容（避免误判）

`output/` 下只有 `胰腺癌/` 带 `summary.json`。`B7-H3_CD276_招募中/`（无 summary，1 条 JSON）与 `FG-M108/`（无 summary，0 条 JSON）会被**跳过**，并在检索结果中以 `incompleteness` 与警告明示：

```
已跳过 2 个不可用数据包：B7-H3_CD276_招募中（缺少 summary.json 清单，视为未完成的采集快照）；
FG-M108（缺少 summary.json 清单，视为未完成的采集快照）。这些包内的记录未纳入本次检索。
```

若目录下**全部**数据包都不可用，服务返回 `NEEDS_SETUP / NO_ARCHIVE_PACKAGES`，**不会**返回空的成功结果。

### 1.2 已知数据异常

- **时间异常**：`胰腺癌/summary.json` 的 `scrape_time` 为 `2026-09-29T08:02:52.730787`，而个别记录自身的 `scrape_time` 为 `2026-08-14T04:02:35.273119`。服务以记录自身时间为准并给出冲突提示。
- **扁平字段不可信**：`details` 中可能出现 `申请人名称 = "12"`、`药物名称` 带 `曾用名:` 与制表符等脏值；**嵌套 `sections` 才是权威**（`sections['二、申请人信息']['申请人名称']`、`sections['一、题目和背景信息']`）。
- **ChiCTR 历史记录无登记号**：语料主键必须是 `project_id`（本机语料 468 条中 `registration_number` 为 NULL 的为 0，但上游 DDL 注释明确历史记录可能为 NULL，因此实现不依赖登记号做唯一键）。
- **ChiCTR 采集缺口**：`crawl_log` 中有 1 条 `detail_failed`，状态诊断会报告 `detailFailures: 1`。
- **ICTRP 静默缺口**：实测 `pancreatic cancer` 查询 `rows_returned 6262` / `upstream_reported_total 6952`，差 690 条。该来源恒带 `lowerBound: true`。

## 2. PII 与再分发

- 本次确认：公开原始资料中的 PII **默认原样可返回**（不自动脱敏），但服务记录来源与访问时间。
- Cookie／token／secret 类字段在日志与错误中**始终剔除**（`redactValue` 按 key 正则与值匹配双重过滤）。
- 证据文件路径限定在配置的 allowlist 根目录内；越界路径被拒绝（`PATH_NOT_ALLOWLISTED`）。
- 调用方须自行遵守各来源条款与适用法律；**公开可访问 ≠ 可无限制再分发**。

## 3. 各来源的失效诊断与处置

### 3.1 ChinaDrugTrials（`chinadrugtrials`）

| 症状（reasonCode） | 含义 | 处置 |
|---|---|---|
| `CHINADRUGTRIALS_COOKIE_MISSING` | 无会话 Cookie | `configure --cookie-from-entry-page`（自动）；失败则 `configure --cookie-from-curl`（人工粘贴浏览器 cURL） |
| `CHINADRUGTRIALS_QUERY_REQUIRED` | 维护未给关键词 | 加 `keyword`；受控来源不支持全量抓取 |
| `CHINADRUGTRIALS_CHALLENGE_REQUIRED` | 出现验证页 | 人工在合法浏览器完成验证，**不要**尝试绕过 |
| `CHINADRUGTRIALS_ACCESS_DENIED` | 401/403 | 会话失效或无权访问；重新获取合法会话 |
| `CHINADRUGTRIALS_RATE_LIMITED` | 429 | 降低频率，稍后重试（服务本身串行化请求） |
| `CHINADRUGTRIALS_HTTP_ERROR` / `_UPSTREAM_ERROR` | 站点异常 | 稍后重试；不改用非官方接口 |
| `CHINADRUGTRIALS_NETWORK_ERROR` | 网络不可达 | 检查网络/代理 |

维护：`sync_chinadrugtrials`（仅 `sync`，单次 ≤10 页，每页 20 条，串行）。

### 3.2 ChiCTR online（`chictr_online`）

| 症状 | 处置 |
|---|---|
| `CHICTR_ONLINE_NOT_CONFIGURED` | `configure --chictr-mcp-server <chictr_trials 目录>` |
| `CHICTR_UPSTREAM_NOT_BUILT` | 在上游目录执行 `npm install && npm run build` |
| `UPSTREAM_BROWSER_MISSING`（`NEEDS_SETUP`） | 上游缺 Playwright 浏览器：`cd <上游> && npx playwright install chromium`。**这是环境缺失，不是“没有结果”** |
| `CHICTR_CHALLENGE_REQUIRED` | 触发人机验证；人工完成，服务不绕过 |
| `CHICTR_COOLDOWN`（`RATE_LIMITED`） | 冷却期；等待后重试 |

上游 `get_access_state` 在检索**之前**检查，因此验证/冷却不会被误报为 0 条。

### 3.3 ChiCTR 胰腺癌语料（`chictr_pancreatic_archive`）

| 症状 | 处置 |
|---|---|
| `CORPUS_NOT_CONFIGURED` | 先取语料：`fetch-corpus`（预览）→ `fetch-corpus --apply`（下载安装）；或手工准备后 `configure --chictr-corpus /abs/path/chictr_pancreatic.db` |
| `PATH_*` 系列 | 检查路径存在、是文件、可读、且在 allowlist 内 |
| `SHA256_MISMATCH` / `SIZE_MISMATCH` | 下载内容与 `corpora/manifest.json` 不符。**原有语料未被改动**。重试；若持续失败，说明资产已被替换，需用 `scripts/pack-corpus.mjs --write-manifest` 重新生成清单 |
| `DOWNLOAD_FAILED` / `DOWNLOAD_HTTP_ERROR` | 默认 Release 不可达或资产未上传。用 `--url` 指向镜像或 `file://` 本地 tar.gz |
| `CORPUS_NOT_IN_MANIFEST` | 该语料尚未发布或清单为空；运行打包脚本并上传 Release 后再试 |
| `TAR_UNAVAILABLE` / `TAR_FAILED` | 目标机缺少可用 `tar`，或归档损坏（后者通常已被 sha256 拦下） |

**获取语料（ADR-008 / ADR-009）**：`fetch-corpus --corpus <id>` 默认 dry run，只打印将访问的 URL、预期字节数、
sha256 与分发依据；`--apply` 才下载。流程为：下载到临时文件 → 校验字节数 → 校验 sha256 → 解压到临时目录 → 校验内容 →
**原子替换**目标目录。任何一步失败都会保留原有数据完全不动，并清理临时目录。
`--url` 支持镜像与 `file://`；`--dest` 指定安装根目录（默认 `~/.unified-trial-mcp/corpora`）。

**两条分发依据刻意分开**，清单条目的 `basis` 字段声明适用哪一条，缺失则拒绝安装（`MANIFEST_BASIS_MISSING`）：

| `basis` | 适用 | 依据 |
|---|---|---|
| `upstream_public` | `chictr_pancreatic` | 上游公开发布、可匿名下载的数据集（ADR-008） |
| `community_owned` | `xyb_cde_pancreatic`、`ctv_index` | 社区自采/自建成果，权利人对自己这份成果拥有分发权（ADR-009）。**与上游站点是否需凭证、是否禁止抓取无关**——社区自建不等于上游公开，两者判断依据不同，不得相互套用 |

两类走**完全相同的技术流程**，区别只在准入判断由谁作出。

**安装布局按语料而异**（`configure` 期望的路径形状不同，装错会导致来源报 `NO_ARCHIVE_PACKAGES`）：

| 语料 | tar.gz 内的包目录 | 安装后形状 | 挂载命令 |
|---|---|---|---|
| `chictr_pancreatic` | `chictr_pancreatic/` | `<dest>/chictr_pancreatic/chictr_pancreatic.db` | `configure --chictr-corpus <dest>/chictr_pancreatic/chictr_pancreatic.db` |
| `xyb_cde_pancreatic` | `胰腺癌/` | `<dest>/xyb_cde_pancreatic/胰腺癌/summary.json` | `configure --xyb-archive <dest>/xyb_cde_pancreatic` |
| `ctv_index` | `ctv.db` | `<dest>/ctv_index/ctv.db` | `configure --ctv-database <dest>/ctv_index/ctv.db` |

安装后按各语料**自己的表**验证可读性（`chictr_pancreatic` → `trials`，`ctv_index` → `studies`）：
"这个 .db 能打开"本身不构成安装可用的证明，错表会以 `no such table` 直接暴露打包错误。

`ctv_index` 是社区自建的 CTV 本地检索索引（1434 条，含 `detail_json` 与 FTS5），压缩后 24 MB。
它**不含**上游 `ctv-mcp-server` 代码，仍需 `configure --ctv-mcp-server <目录>` 并构建；`fetch-corpus` 会把这条要求打印出来。

`--xyb-archive` 指向的是**数据包的父目录**（适配器在其下扫描含 `summary.json` 的子目录，即 `output/` 形状），
而不是包本身；`fetch-corpus` 会保留包目录层级，`--apply` 结束时打印可直接复制的挂载命令。

这是本服务唯一会代替用户下载数据的地方，且只限上表两类已声明依据的语料；
需要凭证或需突破 robots/WAF/验证码的数据依然绝不代取。

语料从打包、发版到部署、更新的完整流程（含三个语料的完整 URL 与摘要、每两个月发新版本的步骤）见
[`docs/corpus-lifecycle.md`](corpus-lifecycle.md)。

该来源为 `READ_ONLY_ARCHIVE`，`maintain()` 直接抛 `NOT_ENABLED`。
检索范围仅限**胰腺癌专题**，结果会带范围警告；`freshness.staleAfterDays = 90`。

**数据截止日**：`freshness.dataCutoff` 由语料内 `trials.updated_at` 与 `crawl_log` 的最大时间戳推导（取较新者），
`cutoffSource` 说明推导依据，`updateHint` 给出更新方式。该日期之后登记的试验在语料中**不可见**，
零结果不能证明不存在。`doctor` 会单独打印该行。语料由小胰宝社区共同维护，需持续更新。

### 3.4 ClinicalTrials.gov / CTV（`ctv`）

| 症状 | 处置 |
|---|---|
| `CTV_MCP_NOT_CONFIGURED` | `configure --ctv-mcp-server <ctv-mcp-server 目录>`（语料只有索引，不含上游代码） |
| `CTV_UPSTREAM_NOT_BUILT` | 上游 `npm install && npm run build` |
| 本地索引 0 命中 | **不等于 CT.gov 上没有**；先跑 `sync_ctv_index`（sitemap 同步或 CSV 导入） |

`csv_import` 模式只接受**主机配置**的 `--ctv-csv-export` 路径，调用方无法通过工具参数指向任意文件。
详情工具固定使用 `include_contacts: false`，**不**放宽上游的 PII 脱敏。

### 3.5 WHO ICTRP（`ictrp`）

| 症状 | 处置 |
|---|---|
| `ICTRP_BUNDLE_NOT_CONFIGURED` | `configure --ictrp-bundle <ictrp-mcp-service 目录>` |
| `ICTRP_UPSTREAM_NOT_BUILT` | 上游 `npm install && npm run build` |

**下界语义**：该来源恒带 `lowerBound: true`，并上报 `upstreamReportedTotal`。零／少结果不能证明试验不存在。
`refresh_ictrp` 才会刷新缓存；查询工具永不刷新。

### 3.6 XYB 数据包（`xyb_chinadrugtrials_archive`）

| 症状 | 处置 |
|---|---|
| `ARCHIVE_NOT_CONFIGURED` | `configure --xyb-archive <output 目录>`，或用 `fetch-corpus --corpus xyb_cde_pancreatic --apply` 下载社区归档后按其打印的命令挂载 |
| `NO_ARCHIVE_PACKAGES` | 目录下无可识别数据包。**先确认路径层级**：`--xyb-archive` 要指向**数据包的父目录**，装成包本身会报 `json/logs/raw/word 均不完整`。其余情况为缺 summary.json 或空包，需补齐采集数据 |
| `SUMMARY_UNRECOGNISED` | `summary.json` 结构异常；检查采集脚本版本 |

**数据截止日**：`freshness.dataCutoff` 取"记录级 `scrape_time` 与 `summary.json` 声明中的较新者"，
`cutoffSource` 标明覆盖率（是否已逐条读取记录）。实测中 `summary.json` 声明的时间可能比记录中最新的一条更新，
因此以记录为准。包内记录抓取时间跨度过大时会额外 warning 说明该区间，不会抹平为单一时间点。
`updateHint` 给出更新方式；数据包由小胰宝社区共同维护，需持续更新。

## 4. 定期维护建议

| 周期 | 动作 |
|---|---|
| 每次环境变更后 | `doctor`，确认退出码与各来源状态 |
| 每周 | `refresh_ictrp`（`apply: true`）刷新 ICTRP 缓存 |
| 按需 | `sync_ctv_index`（优先 sitemap；有官方 CSV 导出时用 `csv_import`） |
| 按需 | `sync_chinadrugtrials`（须给关键词，遵守站点条款与频率） |
| 每季 | 检查 ChiCTR 语料与 XYB 归档的新鲜度（`freshness.stale`）与采集缺口 |

## 5. 验收自查

```bash
npm run typecheck && npm test        # 43/43
node dist/src/cli/main.js doctor     # 逐来源状态
```

手工验收应分别覆盖：无 Cookie、WAF 验证、缺 Python/Node sidecar、无本地 DB、过期 archive，并确认每种情形都得到**明确状态 + fixHint**，且**没有任何一种被映射为 `NO_RESULTS`**。
