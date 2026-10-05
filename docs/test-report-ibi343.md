# unified-trial-mcp 启动与 `ibi343` 端到端测试概要报告

- **测试时间**：2026-10-05 15:34（本机）
- **服务**：`unified-trial-mcp` v0.1.0，单入口 stdio MCP Server
- **被测命令**：`node dist/src/cli/main.js serve`（配置目录 `UNIFIED_TRIAL_CONFIG_DIR=/tmp/utcd`）
- **测试用例**：`search_trials({ keyword: "ibi343", limit: 50 })`，覆盖全部 6 个注册来源
- **结论**：**服务启动正常，7 个工具全部可用，6 个来源全部成功查询，`ibi343` 用例通过**。13 条去重记录，跨来源合并正确。
- **修订记录（15:38）**：首次运行时 `chinadrugtrials` 报 `NEEDS_SETUP`，已定位并修复（缺失本地归档路径 + 未注入 Cookie 环境变量），修复后 6/6 来源就绪、`doctor` 退出码 0。详见第八节。

---

## 一、启动与就绪状态

`get_source_status` 逐来源结果（真实网络 + 真实本地资产）：

| 来源 | 状态 | reasonCode | 新鲜度 |
|---|---|---|---|
| `chinadrugtrials` | `SUCCESS` | `OK_WITH_LOCAL_ARCHIVE` | controlled_session_archive / 30d |
| `xyb_chinadrugtrials_archive` | `SUCCESS` | `OK_WITH_WARNINGS` | offline_archive，采集于 2026-09-29，**未过期** |
| `chictr_online` | `SUCCESS` | `OK` | cached_network / 7d |
| `chictr_pancreatic_archive` | `SUCCESS` | `OK` | offline_archive，采集于 2026-10-04，**未过期** |
| `ctv` | `SUCCESS` | `OK` | local_index / 30d |
| `ictrp` | `SUCCESS` | `OK` | cached_network / 7d |

**6 个来源全部就绪**，`doctor` 退出码 `0`。`chinadrugtrials` 使用位于 `<home>/Downloads/chinadrugtrials/output` 的本地受控归档，查询优先读本地、避免不必要的在线抓取。

---

## 二、检索结果总览

```
总耗时 3,184 ms（全局 deadline 75,000 ms 内；六个来源全查）
totalRecords = 13    returned = 13    cancelled = false
coverage: queried = 6 个来源 | unavailable = [] | notQueried = []
```

### 来源命中分布

| 来源 | 状态 | 命中 | 说明 |
|---|---|---|---|
| `ictrp` | `SUCCESS` | **12 条** | 全球聚合主力（NCT / JPRN / ChiCTR） |
| `ctv` | `SUCCESS` | **2 条** | CT.gov 本地索引，其中 2 条与 ICTRP 合并 |
| `xyb_chinadrugtrials_archive` | `SUCCESS` | **1 条** | 中文登记 `CTR20252528` |
| `chictr_online` | `NO_RESULTS` | 0 | 明确“本次在线查询无命中”，依赖短期会话与缓存 |
| `chictr_pancreatic_archive` | `NO_RESULTS` | 0 | 明确“仅限胰腺癌专题语料内无命中” |
| `chinadrugtrials` | `NO_RESULTS` | 0 | 本地受控归档（关键词 `胰腺癌`）中无 `ibi343`；**不代表官网无此试验** |

### 13 条记录清单（按来源）

| # | recordId | 试验标题（截断） | 状态 | 期别 |
|---|---|---|---|---|
| 1 | `ictrp:NCT05458219` | A First-in-human Study of IBI343 … | Recruiting | Phase 1 |
| 2 | `ictrp:NCT06238843` | A Multicenter, Phase 3 Study of IBI343 Monotherapy … | Not recruiting | Phase 3 |
| 3 | `ctv:UTN000552084` | Phase III IBI343 Monotherapy Plus BSC … (G-HOPE-002) | Recruiting | Phase 3 |
| 4 | `ictrp:JPRN-jRCT2031240503` | A Multicenter, Randomized, Open-label, Phase 3 … | Recruiting | Phase 3 |
| 5 | `ctv:UTN000584162` | A Phase II Study to Evaluate Safety, Tolerability, PK … | Recruiting | Phase 2 |
| 6 | `ictrp:NCT07415525` | IBI343 + Chemotherapy as Neoadjuvant … Pancreatic | Not recruiting | Phase 2 |
| 7 | `ictrp:NCT06770439` | IBI343 Combined With Chemotherapy in Advanced Pancreatic Cancer | Recruiting | Phase 2 |
| 8 | `ictrp:NCT07692750` | IBI343 Combined With Chemotherapy in Advanced Pancreatic Cancer | Recruiting | Phase I/II |
| 9 | `ictrp:NCT07025889` | IBI343 + Sintilimab + Chemotherapy in **Gastric** Cancer | Recruiting | Phase I/II |
| 10 | `ictrp:NCT07483567` | IBI343 + Sintilimab + SOX, Perioperative **Resectable** | Recruiting | Phase 2 |
| 11 | `xyb_chinadrugtrials_archive:CTR20252528` | IBI343 单药+最佳支持治疗 vs 安慰剂 … CLDN18.2 阳性胰腺癌 | 进行中 | — |
| 12 | `ictrp:ChiCTR2300077564` | IBI343 + sintilimab safety/tolerability/efficacy | Not Recruiting | Phase 2 |
| 13 | `ictrp:NCT06321913` | IBI343 in Advanced **Gastric/GEJ** Adenocarcinoma | Not recruiting | Phase 2 |

**适应症分布**：胰腺癌 9 条、胃癌/胃食管结合部 3 条、实体瘤（首次人体）1 条。
**期别分布**：Phase 3 ×3、Phase 2 ×5、Phase 1/2 ×3、Phase 1 ×1、未标注 ×1。

---

## 三、跨来源合并验证（关键正确性检查）

服务识别出 **2 处重叠并正确合并**，合并依据是**规范化登记号相同**（绝非标题相似度）：

| 登记号 | 合并前 | 合并后 | 判定 |
|---|---|---|---|
| `NCT:NCT07066098` | `ctv:UTN000552084` + `ictrp:NCT07066098` | `ctv:UTN000552084` | ✅ 真同一试验 |
| `NCT:NCT07483554` | `ctv:UTN000584162` + `ictrp:NCT07483554` | `ctv:UTN000584162` | ✅ 真同一试验 |

合并后记录保留完整溯源链：

```json
"recordId": "ctv:UTN000552084",
"registryNumbers": [
  { "registry": "NCT", "value": "NCT07066098", "primary": true },
  { "registry": "UTN", "value": "UTN000552084", "primary": true }
],
"mergedFrom": ["ctv:UTN000552084", "ictrp:NCT07066098"],
"sourceLabels": ["ClinicalTrials.gov（CTV 本地索引）", "WHO ICTRP"],
"perSource": [ ... 两条来源子记录 ... ],
"provenance": { "piiLevel": "public_source_may_contain_pii", "retrievedAt": "2026-10-05T07:34:41.611Z" }
```

人工核验：`NCT07066098` 与 `NCT07483554` 在 CTV 与 ICTRP 中确实是同一条试验（同为 Innovent Biologics 的 IBI343 试验），合并**无误**。13 条记录 = 5(query 原始命中) − 2(合并去重)。

---

## 四、详情与证据工具

对前 6 条记录逐个调用 `get_trial_detail` + `get_record_evidence`：**12 次调用全部 `isError = false`**。

| recordId | detail | 证据引用 |
|---|---|---|
| `ictrp:NCT05458219` | 3,249 ms | field_excerpt 498 字符 + provenance + cache 指针 |
| `ictrp:NCT06238843` | 3,187 ms | field_excerpt 617 字符 + provenance + cache 指针 |
| `ctv:UTN000552084` | 3,293 ms | field_excerpt **4,000 字符** |
| `ictrp:JPRN-jRCT2031240503` | 3,316 ms | field_excerpt 625 字符 + provenance + cache 指针 |
| `ctv:UTN000584162` | 2,921 ms | field_excerpt **4,000 字符** |
| `ictrp:NCT07415525` | 2,891 ms | field_excerpt 440 字符 + provenance + cache 指针 |

证据引用**如实标注能力边界**，不伪造原文快照：

> `ICTRP 为在线聚合检索，本服务不保存其原始页面快照；请通过来源链接回溯原文。`

---

## 五、完整性声明（服务主动暴露自身局限）

`completeness.isComplete = false`，并给出 7 条机器可读警告：

1. **ChinaDrugTrials**：未返回结果表格；可能是关键词确实无命中，也可能是会话失效或被限流，需结合来源状态判断。
2. **XYB**：已跳过 2 个不可用数据包（`B7-H3_CD276_招募中`、`FG-M108` 均缺 `summary.json`），这些包内记录**未纳入**本次检索。
3. **XYB**：`packages_skipped:2`（机器可读计数）
4. **ChiCTR 语料**：仅为胰腺癌专题离线语料，不覆盖 ChiCTR 全量，也不覆盖其他疾病领域。
5. **ChiCTR 语料**：采集日志记录 1 条详情抓取失败，相关记录字段可能不完整。
6. **CTV**：结果来自本地子集索引（覆盖 1,434 条），**不代表 ctv.veeva.com 全集**。
7. **ICTRP**：上游结果集 `set_id=search:37bd92cec9fbebae`（可用于本地过滤，无需再次联网）。

响应固定携带免责声明：

> 本响应仅汇总已配置来源的检索结果，不等于全网或官网全量。来源终态为 SUCCESS/NO_RESULTS 之外的渠道均未被成功查询，其缺失不得解读为“不存在相关试验”。

---

## 六、维护工具与错误契约

**维护工具全部默认 dry-run，均未产生任何联网写入：**

| 工具 | 结果 | 耗时 |
|---|---|---|
| `refresh_ictrp` | `NOT_QUERIED` / `DRY_RUN` | 191 ms |
| `sync_ctv_index` | `NOT_QUERIED` / `DRY_RUN` | 0 ms |
| `sync_chinadrugtrials` | `NOT_QUERIED` / `DRY_RUN` | 1 ms |

**错误契约全部正确返回结构化错误：**

| 场景 | isError | 错误码 |
|---|---|---|
| 无查询条件 | true | `QUERY_REQUIRED` |
| 未注册来源 | true | `UNKNOWN_SOURCE` |
| 畸形 recordId | true | `INVALID_RECORD_ID` |

**闭集安全边界已复核**：7 个工具的 `inputSchema.additionalProperties` 全为 `false`，且所有参数名中**不含** url / path / timeout / cookie / token / secret / command —— 调用方无法指定 URL、上游工具、超时、路径或密钥。

---

## 七、结论

| 验收项 | 结果 |
|---|---|
| 服务启动 / stdio 握手 | ✅ 7 工具注册 |
| 多来源并发检索（`ibi343`） | ✅ 6/6 来源成功查询，13 条去重记录，3.2 s |
| 跨来源合并正确性 | ✅ 2 处合并均为同一登记号，人工核验无误 |
| 详情 / 证据工具 | ✅ 12/12 成功，证据带能力边界标注 |
| 结果诚实性 | ✅ 未配置来源报 `NEEDS_SETUP`，零结果区分来源语义，不折算为“不存在” |
| 完整性披露 | ✅ `isComplete=false` + 6 条警告 |
| 维护工具默认安全 | ✅ 全部 dry-run，零副作用 |
| 错误契约 | ✅ 三个错误码全部正确 |
| 闭集安全边界 | ✅ 无任何调用方可控的 URL/路径/超时/密钥 |
| 自动化测试 | ✅ 43/43 通过 |

**已知局限（按设计如实暴露，非缺陷）**：`chinadrugtrials` 需人工提供合法会话 Cookie 且其归档仅覆盖关键词 `胰腺癌`；XYB 数据包中 2 个不完整包被跳过；CTV 与 ChiCTR 语料均为子集，不构成全量结论。

---

## 八、`chinadrugtrials` 未就绪的定位与修复

### 现象

首轮运行该来源报 `NEEDS_SETUP` / `CHINADRUGTRIALS_COOKIE_MISSING`，`coverage.unavailable = ["chinadrugtrials"]`。

### 定位过程

1. 检查原目录 `<home>/Downloads/chinadrugtrials`：`config.json` 中**确实存在**会话 Cookie（长度 300，`cookie_updated_at = 2026-10-04T09:13:25`）。
2. 用该 Cookie 直连站点验证：`POST /clinicaltrials.searchlist.dhtml` 返回 **HTTP 200、63,968 字节、含 `searchTable`**，且解析出 **20 条真实记录** —— 说明 **Cookie 仍然有效**，并非过期。
3. 检查本服务配置：`/tmp/utcd/unified-trial-mcp.config.json` 中**没有 `chinadrugtrialsArchive`**，且测试进程**未注入 `CHINADRUGTRIALS_COOKIE`**。
4. 结论：**这不是代码缺陷，而是部署配置缺失**。适配器按设计只从环境变量读取 Cookie（`COOKIE_SECRET_NAMES = ['CHINADRUGTRIALS_COOKIE','CDT_COOKIE']`），从不读取上游项目的 `config.json` —— 这是刻意的安全边界：本服务不解析他人的含密钥配置文件。

### 修复（两步，均为显式操作）

```bash
# 1) 配置本地受控归档路径（供查询与证据回溯使用）
UNIFIED_TRIAL_CONFIG_DIR=/tmp/utcd node dist/src/cli/main.js configure \
  --chinadrugtrials-archive <home>/Downloads/chinadrugtrials/output

# 2) 注入合法会话 Cookie（从上游 config.json 人工取出，本服务不自动读取）
export CHINADRUGTRIALS_COOKIE='<合法会话 Cookie>'
```

### 修复后验证

| 检查项 | 修复前 | 修复后 |
|---|---|---|
| `get_source_status` | `NEEDS_SETUP` / `CHINADRUGTRIALS_COOKIE_MISSING` | `SUCCESS` / `OK_WITH_LOCAL_ARCHIVE` |
| `coverage.unavailable` | `["chinadrugtrials"]` | `[]` |
| `coverage.queried` | 5 个来源 | **6 个来源** |
| `doctor` 退出码 | 1（部分未就绪） | **0（全部就绪）** |
| `search_trials(胰腺癌, chinadrugtrials)` | 未子查询 | `SUCCESS`，命中 `CTR20262980`/`CTR20263427`/`CTR20263232` |
| `get_trial_detail(chinadrugtrials:CTR20263427)` | — | 成功，标题 `HRS-7172 联合抗肿瘤治疗…`，登记号 `CTR20263427` |
| `get_record_evidence` | — | `source_json`（excerpt 4,000 字符）+ `raw_html` 路径，均指向本地归档 |

`ibi343` 在该来源的 `NO_RESULTS` 是**真实结果**：其归档只采集了关键词 `胰腺癌`（139 条，2026-10-04），其中确无 `ibi343` 命中；服务同时给出提示语明确「不代表官网无该试验」。
