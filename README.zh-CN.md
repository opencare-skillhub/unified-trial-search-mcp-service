# 统一临床试验检索 MCP 服务

[![中文](https://img.shields.io/badge/README-中文-red)](./README.zh-CN.md)
[![English](https://img.shields.io/badge/README-English-blue)](./README.md)
[![CI](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml/badge.svg)](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](#许可证)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/测试-46%20通过-success)](#测试)
[![Sources](https://img.shields.io/badge/数据源-6%20个通道-orange)](#六个数据通道)
[![Tools](https://img.shields.io/badge/MCP%20工具-7%20个-blueviolet)](#七个-mcp-工具)

**一个 MCP 入口，同时检索六个临床试验通道 —— 并且绝不对"没查到"的事撒谎。**

> 💚 本项目由 **小胰宝（XiaoYiBao）社区** 贡献者 **Sam** 的用心付出促成，在此致谢。

![架构图：一个封闭的 MCP 工具面覆盖六个通道，由封闭来源注册表编排，返回逐来源的终态](docs/assets/architecture.svg)

`doctor` 如实报告每个通道的状态 —— 且从不打印 Cookie：

![unified-trial-mcp doctor 的终端输出：六个来源全部就绪，退出码 0](docs/assets/doctor.png)

---

## 为什么需要它

检索过临床试验的人都熟悉这个流程：五个浏览器标签页、四个不同的注册库搜索框、三种不同的登记号格式，
而且**无法判断"0 条结果"到底意味着*试验不存在*，还是*索引根本没覆盖到***。

现有的临床试验 MCP 服务都是"一个注册库一个服务"。但这恰恰与人们真正要问的问题不匹配 ——
*"我这个患者，全世界有没有可参加的试验？"* —— 因为只有当你能证明"我确实都查过了"、
并诚实说明"哪些地方我没查到"时，这个答案才有意义。

**本服务把六个通道收敛到一个封闭的工具面之后**，围绕一条不容妥协的原则构建：

> **绝不把"我没能查"悄悄变成"它不存在"。**

这一条原则，几乎决定了下面所有的设计取舍。

## 独特价值

| | 常见的单库 MCP | **本服务** |
|---|---|---|
| 通道数 | 1 | **6**（在线 + 离线语料） |
| 跨源去重 | ✗ | ✅ 仅在**确认同一登记身份**时合并 |
| "0 条结果" | 直接返回 | ✅ **绝不**单独返回，必带该来源自身的覆盖声明 |
| 失败报告 | 笼统报错 | ✅ **10 个机器可读终态** |
| 部分覆盖 | 不可见 | ✅ `coverage` + `completeness` + 截断标记 |
| 调用方指定 URL／超时 | 常见 | ✅ **结构上不可能**（封闭注册表） |
| 配置中的秘密 | 常有 | ✅ 独立 `cookie.env`，权限 0600，永不打印 |
| 新环境部署 | 手工部署 5 个服务 | ✅ **只注册一个** + `doctor` + 引导式 `bootstrap` |

### 一句话概括

**这是目前 GitHub 上覆盖最完整的临床试验 MCP 服务** —— 全球注册库、中国注册库、CDE 药物临床试验
登记平台三条主线全部打通，并且独家提供 **NMPA／ChinaDrugTrials 的研究者（PI）信息**，
这是其他任何临床试验 MCP 都拿不到的数据。

## 六个数据通道

| 来源 ID | 通道 | 类型 | 擅长什么 |
|---|---|---|---|
| `ictrp` | WHO ICTRP | 在线聚合 | 全球广度，天然多注册库 |
| `ctv` | Veeva CTV | 在线 + 本地 FTS | ClinicalTrials.gov 深度，本地索引快 |
| `chictr_online` | ChiCTR | 在线 | 中国注册试验，实时 |
| `chictr_pancreatic_archive` | ChiCTR 离线语料 | 离线 SQLite | 468 条胰腺癌记录 + 原始 HTML，**数据截止 2026-10-04** |
| `chinadrugtrials` | ChinaDrugTrials | 受控抓取 | **含研究者（PI）信息** |
| `xyb_chinadrugtrials_archive` | 小胰宝归档 | 离线数据包 | 139 条胰腺癌记录，结构化章节，**数据截止 2026-09-28** |

### 获取离线语料

三个离线语料都以 **Release 资产**发布，冷启动不必再四处找文件。
下面全部是公开链接，**不需要任何 token、会话或 VPN**。

#### 三个资产

| 语料 | 下载 | 字节数 | sha256（前 16 位） | 挂载参数 | 依据 |
|---|---|---|---|---|---|
| `chictr_pancreatic` | [chictr_pancreatic.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz) | 25,381,264 | `abbfc53ba346741b` | `--chictr-corpus` | `upstream_public` |
| `xyb_cde_pancreatic` | [xyb_cde_pancreatic.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz) | 11,032,155 | `d1ccdac0ef5462a6` | `--xyb-archive` | `community_owned` |
| `ctv_index` | [ctv_index.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz) | 23,964,370 | `41f07ea5a0b7c1b8` | `--ctv-database` | `community_owned` |

完整摘要见 [`corpora/manifest.json`](corpora/manifest.json)，它同时也是 `fetch-corpus` 强制校验的契约。
Release 页面：[chictr](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/chictr_pancreatic-2026-10-05) ·
[xyb_cde](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/xyb_cde_pancreatic-2026-10-05) ·
[ctv_index](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/ctv_index-2026-10-05)。

#### 自动方式（推荐）

会校验 sha256 与字节数；任何一步失败都**不会损坏你已有的数据**：

```bash
unified-trial-mcp fetch-corpus --corpus chictr_pancreatic --apply
unified-trial-mcp configure --chictr-corpus ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db

unified-trial-mcp fetch-corpus --corpus xyb_cde_pancreatic --apply
unified-trial-mcp configure --xyb-archive ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic

unified-trial-mcp fetch-corpus --corpus ctv_index --apply
unified-trial-mcp configure --ctv-database ~/.unified-trial-mcp/corpora/ctv_index/ctv.db
```

先去掉 `--apply` 就是演练：只打印将访问的 URL、字节数、摘要与分发依据，不下载任何内容。
`unified-trial-mcp bootstrap` 会交互式走完整个冷启动，并可串联上述步骤。

#### 手动方式（走镜像、离线机房，或 Release 不可达时）

用任意手段下载上面三个链接，逐一对照 `corpora/manifest.json` 校验摘要，解压后挂载：

```bash
# 1. 校验（以 chictr 为例）
shasum -a 256 chictr_pancreatic.tar.gz   # 必须等于清单中的 sha256

# 2. 解压 —— 注意三个语料解压后的目录层级并不相同
tar -xzf chictr_pancreatic.tar.gz -C ~/.unified-trial-mcp/corpora/
tar -xzf xyb_cde_pancreatic.tar.gz -C ~/.unified-trial-mcp/corpora/
tar -xzf ctv_index.tar.gz -C ~/.unified-trial-mcp/corpora/

# 3. 挂载解压出来的路径
unified-trial-mcp configure \
  --chictr-corpus ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db \
  --xyb-archive   ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic \
  --ctv-database  ~/.unified-trial-mcp/corpora/ctv_index/ctv.db

unified-trial-mcp doctor   # 每个就绪来源都会打印 OK
```

也可以让 `fetch-corpus` 直接指向自建镜像，不必手工拷贝——摘要校验依然生效：

```bash
unified-trial-mcp fetch-corpus --corpus ctv_index --url https://your-mirror/ctv_index.tar.gz --apply
unified-trial-mcp fetch-corpus --corpus ctv_index --url file:///srv/airgap/ctv_index.tar.gz --apply
```

**解压层级并不统一**，装错不会在安装时报错，而是在**查询时**才暴露。两个参数指向**文件**
（`--chictr-corpus`、`--ctv-database`），数据包直接位于语料目录下；`--xyb-archive` 指向**数据包的父目录**
——适配器要在其下扫描含 `summary.json` 的子目录——所以该包保留一层目录：

```
corpora/chictr_pancreatic/chictr_pancreatic.db   <- 文件直接在目录下
corpora/ctv_index/ctv.db                         <- 文件直接在目录下
corpora/xyb_cde_pancreatic/胰腺癌/summary.json    <- 保留包目录一层
```

#### 分发依据（为什么这三个可以分发）

这两条依据**刻意分开**（规范 ADR-009）。只有第一条建立在"数据本身公开"之上；后两条依据的是**社区对自己成果的权利**，
上游 CDE 站点需要 Cookie 会话、`ctv.veeva.com/robots.txt` 禁止抓取 `/study-search`，这些都与**该依据无关**，绝不能拿来论证它。
把两者混为一谈，等于悄悄废掉"本服务绝不代取需凭证数据"这条底线。

`ctv_index` 只含索引，**不含**上游 `ctv-mcp-server` 代码。它仍需单独的代码目录（见[环境要求](#环境要求)）；
`fetch-corpus` 会明确打印这条要求，而不是暗示来源已就绪。

其中两个参数指向**文件**（`--chictr-corpus`、`--ctv-database`），数据包直接落在安装目录下；
`--xyb-archive` 指向**数据包的父目录**（适配器要在其下扫描含 `summary.json` 的子目录），所以该包保留一层目录。
安装后还会按各语料**自己的表**验证（`trials` 与 `studies`）——"这个 .db 能打开"本身不构成安装可用的证明。

CTV 索引还有一半是下载提供不了的：它查询的上游 `ctv-mcp-server` 目录。`fetch-corpus` 会把这一要求明确打印出来，
而不是假装来源已就绪。有了索引，冷启动无需再爬站——但它返回零结果时依然只代表"不在本索引内"，不代表试验不存在。

这条命令遵守四条规则：

- **sha256 就是契约。** 字节数与摘要全部来自 `corpora/manifest.json`，任何一项不符即整体失败；
- **下载失败绝不损坏你已有的数据。** 先下到临时文件、校验、解压到临时目录，确认无误才替换。已实测：
  篡改 1 个字节后安装中止并报校验错误，原有语料逐字节不变；
- **绝不代取需凭证的数据。** 不会把用户本没有的访问权交给他：会话、受控归档、需过验证码的内容一律保持手工
  （ADR-006）。每个语料都要声明自己的依据（`upstream_public` 或 `community_owned`），未声明依据的资产安装时直接拒绝（ADR-009）；
- **镜像用 `--url`。** 支持 `https://…` 与 `file:///…`，适配内网与离线机房。

数据版权归各自来源方所有。ChiCTR 语料是公开快照的只读搬运；小胰宝 CDE 归档与 CTV 索引是社区自采/自建成果，
且登记信息可能被上游随时修订，请把它们当作有截止日的快照而非事实源的最终版本。

### 离线快照会声明自己的数据截止日

两个离线来源是**快照**，不是实时数据。它们会明确报告自己的数据截止日，因为截止日之后登记的试验是
**不可见**，而不是**不存在** —— 这正是本项目存在的意义所在：

```jsonc
"freshness": {
  "kind": "offline_archive",
  "dataCutoff": "2026-09-28T07:59:24.275394+08:00",  // 包内没有任何记录新于此
  "cutoffSource": "各数据包内记录级 scrape_time 与 summary.json 声明（较新者）；覆盖率 已逐条读取记录",
  "updateHint": "……小胰宝社区按关键词抓取并共同维护……通过 configure --xyb-archive 指向新包……"
}
```

三条约束：

- **截止日从数据推导，绝不硬编码** —— 硬编码的日期会在别人更新数据而没改代码的那一刻变成谎话；
- **记录级时间优先于 summary 声明** —— 实测中 `summary.json` 声明 `2026-09-29`，而 139 条记录里最新的是
  `2026-09-28`，且最早可追溯到 `2026-08-13`；这个跨度会被显式报告，不会被抹平成"某个时间点"；
- **`dataCutoff` 同时出现在 `search_trials` 与 `get_source_status` 的响应里** —— 零结果回答必须自带
  "这份快照停在哪里"，否则它和实时注册库的零结果长得一模一样。

数据由**小胰宝社区共同维护**，需要大家一起持续更新。运行 `doctor` 可随时查看当前截止日。

### 经得起核验的跨源身份合并

检索会并发扇出，然后合并结果 —— 但**只在确认登记身份一致时才合并**：

```
ctv:UTN000552084  ┐
                  ├─►  NCT:NCT07066098   （同一试验，两个视角）
ictrp:NCT07066098 ┘
```

**标题完全相同但登记号不同的两条记录，永远不会被合并。** 已在真实数据上验证：
15 条原始命中 → 13 条规范记录，2 处合并均经人工核验。每条合并记录都保留
`mergedFrom`、`sourceLabels` 与 `perSource`，合并过程始终可审计。

## 状态码解读

`search_trials` 为每个来源返回一个终态。**只有 `SUCCESS` 和 `NO_RESULTS` 表示该来源真的被查过了**；其余八种都表示这一路没拿到结果，此时不能对"该试验是否存在"下任何结论。

| 状态 | 调用方应当如何解读 |
|---|---|
| `SUCCESS` | 该来源已查询并返回结果。结果是否完整另看 `completeness`。 |
| `NO_RESULTS` | 该来源已查询，确实没有匹配。请连同 `coverage.zeroResultMeaning` 一起理解——它说明这个"空"对该来源到底意味着什么。 |
| `NOT_ENABLED` | 该来源在本次部署中被关闭，没有发起任何请求。 |
| `NEEDS_SETUP` | 该来源缺依赖、路径、运行时或会话，无法查询。`fixHint` 给出修复方式。 |
| `NOT_QUERIED` | 从未尝试发起请求（通常是总时限已到）。与"查了但失败"不同，计数时可单独统计。 |
| `TIMEOUT` | 请求已发出，但未在时限内返回。结果未知。 |
| `CHALLENGE_REQUIRED` | 上游要求人工验证。本服务不会绕过验证码或 WAF。 |
| `RATE_LIMITED` | 被上游限流。稍后重试可能成功。 |
| `DENIED` | 来源拒绝访问（权限或会话失效）。 |
| `FAILED` | 已尝试但出错。`reasonCode` 与 `explanation` 给出原因。 |

每条记录另有 `attempted` 字段：`false` 表示根本没发起请求。`NO_RESULTS` 与 `TIMEOUT` 都可能是"没查到"，但只有前者说明上游确认了空结果。

**三类来源需要特别解读：**

- **CTV 是本地索引。** 未命中只说明本地 SQLite/FTS 里没有，不代表 ClinicalTrials.gov 上没有：
  > 仅表示本地 SQLite/FTS 索引未命中，不代表 ClinicalTrials.gov 上不存在该试验。

- **ICTRP 是下界。** 该来源永久带 `isLowerBound: true`，其导出的已知静默缺口意味着零结果或少结果都不能推出"不存在"：
  > 上游标注结果不完整，估计缺失 N 条；ICTRP 导出存在已知静默缺口，零/少结果不能作为"不存在"的结论。

- **两个离线快照声明了数据截止日**（见下一节）。截止日之后登记的试验在快照里看不见，这不等于"不存在"。

## 七个 MCP 工具

**查询类（只读 —— 绝不联网刷新、绝不修改索引）：**

| 工具 | 必填 | 用途 |
|---|---|---|
| `search_trials` | `keyword`/`keywords`/`condition`/`terms` 至少一个 | 有界并发扇出；返回来源级终态、覆盖与完整性 |
| `get_trial_detail` | `recordId` | 单条详情；`recordId` 形如 `<sourceId>:<sourceRecordId>` |
| `get_record_evidence` | `recordId` | 原始证据：`raw_html`/`source_json`/`source_word`/`raw_text`/`field_excerpt` |
| `get_source_status` | — | 逐来源就绪状态、新鲜度与诊断 |

**维护类（必须显式调用，默认 dry-run）：**

| 工具 | 用途 |
|---|---|
| `refresh_ictrp` | 刷新 ICTRP 缓存／快照 |
| `sync_ctv_index` | 重建 CTV 本地索引 |
| `sync_chinadrugtrials` | 增量归档 ChinaDrugTrials |

### 封闭注册表保证

`search_trials` **只接受已注册的来源 ID**。没有任何工具接受 URL、上游工具名、自定义超时、
文件系统路径、Cookie 或秘密。调用方**无法把这个服务指向任意端点** —— 这由 schema 强制，
并有测试逐一扫描每个工具的属性名，确保不含 `url`/`path`/`timeout`/`cookie`/`token`/`secret`/
`credential`/`command`/`tool` 等禁止字段。

## 安装

需要 **Node ≥ 22.13**。离线语料路径不需要 Python。

这个下限由 `node:sqlite`（ChiCTR 语料适配器使用）决定：该模块自 Node 22.5.0 起存在，
22.13.0 起不再需要 `--experimental-sqlite` 标志。在更低版本上服务仍能启动，其余来源照常可用，
仅 ChiCTR 语料这一来源报 `NEEDS_SETUP`（`NODE_SQLITE_UNAVAILABLE`）并给出需升级到的版本。

已发布到 npm，可直接安装：

```bash
npm install -g unified-trial-mcp
unified-trial-mcp doctor        # 逐来源诊断
```

或从源码构建：

```bash
git clone https://github.com/opencare-skillhub/unified-trial-search-mcp-service.git
cd unified-trial-search-mcp-service
npm install
npm run build
```

从源码构建时，`npm run build` 会给编译产物补上可执行位。这一步是必要的：
`tsc` 输出 0644，若缺少该权限，`npm install -g` 得到的命令会以
"permission denied" 失败，而本地用 `node dist/...` 运行不会暴露这个问题。

### 注册到 MCP 客户端

```json
{
  "mcpServers": {
    "unified-trial-mcp": {
      "command": "node",
      "args": ["/绝对路径/unified-trial-search-mcp-service/dist/src/cli/main.js", "serve"],
      "env": { "UNIFIED_TRIAL_CONFIG_DIR": "/绝对路径/.unified-trial-mcp" }
    }
  }
}
```

**只注册这一个。整合工作到此结束。** 其余通道由本服务自己去对接。

### 五分钟上手

```bash
# 1) 诊断：逐来源报告运行时、依赖、数据路径、新鲜度与会话
node dist/src/cli/main.js doctor

# 2) 挂载本地资产（写入 <configDir>/unified-trial-mcp.config.json，权限 0600）
node dist/src/cli/main.js configure \
  --chictr-corpus     /绝对路径/chictr_pancreatic.db \
  --xyb-archive       /绝对路径/xyb-chinadrugtrials-data/output \
  --ictrp-bundle      /绝对路径/ictrp-mcp-service \
  --ctv-mcp-server    /绝对路径/ctv-mcp-server \
  --chictr-mcp-server /绝对路径/chictr_trials

# 3) 显式初始化（默认 dry-run，只打印计划）
node dist/src/cli/main.js bootstrap
node dist/src/cli/main.js bootstrap --apply

# 4) 获取公开发布的 ChiCTR 语料（ADR-008）；先 dry run，再 --apply
node dist/src/cli/main.js fetch-corpus
node dist/src/cli/main.js fetch-corpus --apply

# 4) 取得 ChinaDrugTrials 会话（全自动；失败会引导人工兜底）
node dist/src/cli/main.js configure --cookie-from-entry-page

# 5) 再次诊断
node dist/src/cli/main.js doctor
```

`doctor` 退出码：`0` 全部就绪 · `1` 降级但可用 · `2` 没有可用来源。

若任何环节缺失，`doctor` 与 `bootstrap` 会打印**可直接复制的下一条命令**，绝不只给一句"未就绪"。

## 配置

| 优先级 | 机制 |
|---|---|
| 1（最高） | CLI 参数 |
| 2 | 环境变量 |
| 3 | 配置文件 |
| 4 | 默认值 |

配置目录下有两个文件，职责刻意分离：

| 文件 | 内容 | 权限 |
|---|---|---|
| `unified-trial-mcp.config.json` | 只含路径 —— **永不含秘密**，可安全复制或提交 | `0600` |
| `cookie.env` | 会话 Cookie，由 `configure` 写入 | `0600` |

真实环境变量**优先于** `cookie.env`，因此显式 `export` 总能覆盖。缺失 `cookie.env` 视为
"未配置"，绝不凭空产生凭证。

### 关于 ChinaDrugTrials 会话

新环境**无需人工翻阅浏览器**即可取得：

```bash
unified-trial-mcp configure --cookie-from-entry-page
```

它发起**一次站点公开入口页的普通 GET**，取回站点主动下发的两个匿名反爬票据
（`FSSBBIl1UgzbN7N80S` / `...T`），然后用**一次真实只读检索来实测校验**，通过后才保存。
若站点需要登录态，人工兜底方式为：

```bash
unified-trial-mcp configure --cookie-from-curl '<浏览器「复制为 cURL」的命令>'
```

**这不是绕过 WAF，而且这个区分至关重要。** 这些票据是站点在正常访问时就*主动给我们*的：
没有解验证码、没有破挑战、没有规避限流、没有伪造凭证。这与"击败访问控制"有本质区别，
后者本服务永不做。`doctor` 与 `bootstrap` **绝不**自行获取 Cookie，只打印命令并说明失败原因。
服务也不读取其他项目的配置文件或浏览器 Profile。

### 备用手动配置（不走交互式 bootstrap）

不想用 `bootstrap`，或它检测有误时，可以直接用 `configure` 逐项指定。所有路径必须是**绝对路径**，
且要落在 allowlist 之内；含中文的路径无需转义：

```bash
unified-trial-mcp configure \
  --chictr-corpus   ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db \
  --xyb-archive     ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic \
  --ctv-database    ~/.unified-trial-mcp/corpora/ctv_index/ctv.db \
  --ctv-mcp-server  /path/to/ctv-mcp-server \
  --chictr-mcp-server /path/to/chictr_trials \
  --ictrp-bundle    /path/to/ictrp-mcp-service
```

配置写在 `~/.unified-trial-mcp/unified-trial-mcp.config.json`（**永不含秘密**）；ChinaDrugTrials 的
Cookie 单独存在同目录 `cookie.env`（权限 0600）。三个离线语料都不配置也能跑，
只是对应来源会报 `NEEDS_SETUP` 并给出修复命令，不影响其余来源。

## 安全边界

- 不绕过 Cookie、访问控制、robots、WAF、验证码或其他反自动化机制。
- 不自动获取秘密或受控数据；只有显式命令才会触发。
- 永不打印 Cookie 值（仅打印字段名与长度指纹）。
- 所有日志与错误路径均做秘密字段剔除。
- 证据路径限定在已配置根目录的 allowlist 之内。
- 不把"没查到"变成"不存在"：见上文「状态码解读」。

## 项目结构

```
src/
  core/         类型、注册表、配置、编排器、合并器、规范化、日志、MCP 传输
  adapters/     每通道一个：ictrp、ctv、chictr-online、chictr-pancreatic、
                chinadrugtrials、xyb-archive
  tools/        7 个 MCP 工具：schemas、handlers、server
  cli/          单一入口：serve / doctor / bootstrap / configure；Cookie 获取
test/           46 个测试：单元、适配器、编排器、工具
scripts/        CI 守卫（封闭注册表不变量）
docs/           运维手册、测试报告、图表资源
.github/        CI 工作流：类型检查、构建、3 轮测试、不变量守卫
```

## 测试

```bash
npm test
```

```
# tests 46
# pass 46
# fail 0
```

其中一个测试是"可选启用"的：它需要真实的 ChiCTR 语料快照（CI 不提供该数据）。未提供时结果
为 `45 通过 / 1 跳过`；如需对本地语料实测：

```bash
UNIFIED_TRIAL_TEST_CHICTR_CORPUS=/path/to/chictr_pancreatic.db npm test
```

覆盖范围：记录身份与规范化、仅在确认身份时合并、适配器对真实数据的契约、
4 并发／75 秒总时限编排器（含"从未启动"与"已超时"的区分）、全部 7 个工具的 schema 与
错误契约、Cookie 获取与掩码、挑战页识别。

已对真实来源完成端到端验证：六通道全量 `search_trials`、跨源合并、详情与证据检索、
维护工具 dry-run，以及**在零环境变量下**走通完整的新环境 Cookie 流程。

### 持续集成

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 在每次 push 与 PR 上运行，矩阵覆盖
**Node 22.13 与 24** × **Ubuntu 与 macOS**：类型检查 → 构建 → **连跑 3 轮测试**（本项目含
时限与并发敏感路径，单轮通过证据不足）→ CLI 冒烟 → 两道不变量守卫：

- **无凭证入库** —— 一旦 `cookie.env` 或配置文件被纳入版本控制即失败。
- **封闭注册表** —— [`scripts/check-closed-registry.mjs`](scripts/check-closed-registry.mjs)
  在测试进程之外重新校验构建产物的 schema，任何工具属性一旦允许调用方指定端点、路径、
  超时或凭证，即判定构建失败。

## 已知数据注意事项

公开记录而非隐藏 —— 详见 [`docs/operations.md`](./docs/operations.md)：

- 小胰宝归档 `summary.json` 的 `scrape_time` 与单条记录冲突。
- ChinaDrugTrials 扁平 `details` 不可信（`申请人名称 = "12"`）；嵌套 `sections` 才是权威。
- 31 条历史 ChiCTR 记录 `registration_number = NULL` —— `project_id` 才是真实身份。
- ICTRP 存在已知静默缺口，因此少量结果不能证明不存在。

## 许可证

MIT，详见 [LICENSE](./LICENSE)。

> ⚠️ 公开来源资料可能包含个人信息。返回数据如实反映其来源；请遵守各注册库的服务条款与适用法律，
> 不要将"公开可访问"理解为"可无限制再分发"。切勿提交 `cookie.env`。

---

## 致谢 / Acknowledgements

> **小胰宝社区，依托AI+人文，全心全意为患者/家属服务！**

本项目由 **小胰宝（XiaoYiBao）社区** 贡献者 **Sam** 的 ❤️ 付出促成 —— 感谢他的用心与坚持。

This project was made possible by the ❤️ care and hard work of **Sam**, contributor to the
**小胰宝 (XiaoYiBao) community**. Thank you.

> **小胰宝社区，依托AI+人文，全心全意为患者/家属服务！**
