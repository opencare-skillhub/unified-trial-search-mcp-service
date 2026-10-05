# YL201 主要研究者（PI）查询报告

- 查询词：`YL201`
- 测试时间：2026-10-05
- 服务：`unified-trial-mcp`（单一 stdio MCP 进程，7 个工具）
- 数据来源：ChinaDrugTrials 官网（CTR 登记号）详情页「四、研究者信息」章节

## 一、结论

YL201（注射用 YL201，苏州宜联生物医药有限公司）国内已登记 11 项临床试验，主要研究者（PI）如下：

| 登记号 | 适应症 | 分期 | 主要研究者（PI） | 组长单位 |
|---|---|---|---|---|
| CTR20263221 | 转移性胰腺导管腺癌 | III 期 | 王理伟、蒋奎荣 | — |
| CTR20262873 | 广泛期小细胞肺癌 | III 期 | 张力、刘宏旭 | — |
| CTR20261009 | 食管鳞癌 | III 期 | 于金明、王琳琳 | — |
| CTR20254191 | 复发或转移性鼻咽癌 | — | 张力、麦海强 | — |
| CTR20253697 | 晚期实体瘤（联合依沃西单抗） | I 期 | 张力、赵洪云 | — |
| CTR20244561 | 复发或转移性鼻咽癌 | III 期 | 张力 | — |
| CTR20244294 | 复发性小细胞肺癌 | III 期 | 张力 | — |
| CTR20241304 | 晚期实体瘤（联合斯鲁利单抗±铂类） | I 期 | 张力 | — |
| CTR20240246 | 转移性去势抵抗性前列腺癌（mCRPC） | II 期 | **叶定伟** | 复旦大学附属肿瘤医院 |
| CTR20232651 | 晚期实体瘤 | I/II 期 | 张力 | — |
| CTR20222005 | 晚期实体瘤 | I 期 | 张力 | — |

**总结：**

- **张力**（中山大学肿瘤防治中心）是 YL201 临床开发的核心 PI，主导 8 项试验（涵盖肺癌、鼻咽癌、食管癌、实体瘤）。
- **叶定伟**（复旦大学附属肿瘤医院）主导前列腺癌（mCRPC）适应症的 II 期试验 `CTR20240246`。
- 其余按适应症分布的联合 PI：王理伟/蒋奎荣（胰腺癌）、刘宏旭（小细胞肺癌）、于金明/王琳琳（食管鳞癌）、麦海强（鼻咽癌）、赵洪云（实体瘤）。
- 所有 11 项试验的申请人（申办者）均为**苏州宜联生物医药有限公司**（MediLink Therapeutics）。

## 二、PI 数据来源说明（重要）

**PI 信息只在 ChinaDrugTrials 详情页中。** 实测确认：

| 来源 | 是否含 PI | 说明 |
|---|---|---|
| ChinaDrugTrials（CTR） | **是** | 详情页「四、研究者信息 → 1、主要研究者信息」章节；含姓名、学位、职称、电话、Email、邮政地址、邮编、单位名称 |
| CTV | 否 | 详情含 52 个试验机构（`locationFacility`/`locationCity`/`locationCountry`），但 `studyLocationContact` 均为 `null`；上游默认屏蔽研究者 PII |
| ICTRP | 否 | 导出字段仅到申办者层级（`primary_sponsor`），无研究者 |
| ChiCTR（在线/离线） | 否 | YL201 无命中 |
| XYB 归档 | 否 | YL201 无命中（该包采集关键词为「胰腺癌」） |

因此若需 PI，必须走 ChinaDrugTrials 来源，且该来源需要**合法会话 Cookie**（受控来源，本服务不自动获取）。

### CTR20240246 完整研究者记录示例

```
姓名：叶定伟        学位：医学博士      职称：教授
电话：13701663571   Email：dwyeli@163.com
邮政地址：上海市-上海市-上海市东安路270号   邮编：200032
单位名称：复旦大学附属肿瘤医院
```

该试验共 24 家参加机构，PI 分布：复旦大学附属肿瘤医院（叶定伟）、南京大学医学院附属鼓楼医院（郭宏骞）、重庆大学附属肿瘤医院（鲜鹏）、天津医科大学第二医院（王勇）等。

## 三、全来源检索结果

`search_trials(keyword="YL201", limit=50)` → **25 条去重记录**，覆盖 6 个来源：

| 来源 | 状态 | 返回 | 说明 |
|---|---|---|---|
| `chinadrugtrials` | SUCCESS | 12 条 | 中国 CTR 登记（含 1 条无关记录 `CTR20131257`，见下） |
| `xyb_chinadrugtrials_archive` | NO_RESULTS | 0 | 该包按「胰腺癌」采集，不含 YL201 |
| `chictr_online` | NO_RESULTS | 0 | 本次在线查询无命中 |
| `chictr_pancreatic_archive` | NO_RESULTS | 0 | 胰腺癌专题语料，不含 YL201 |
| `ctv` | SUCCESS | 8 条 | Veeva 子集索引（覆盖 1434 条） |
| `ictrp` | SUCCESS | 13 条 | WHO ICTRP 聚合（上游标注估计缺失 2 条） |

### ⚠️ 一处搜索噪声（已识别，非缺陷）

`chinadrugtrials` 返回中包含 `CTR20131257`「依拉地平片治疗轻、中度原发性高血压临床试验」—— 与 YL201 **无关**。

原因：ChinaDrugTrials 站点的关键词检索是**宽匹配**，`YL201` 命中了该记录文本中的某些片段（站点返回 12 条，而我们期望 11 条）。这是**上游站点的检索行为**，不是本服务的缺陷；本服务如实透传上游结果，不做二次过滤（避免误删真实命中）。

`CTR20131257` 之外的 11 条均为 YL201 真实试验，与站点按关键词 `YL201` 检索得到的 11 条 CTR 记录完全一致（见第一节表格）。

### ICTRP 完整性警示

上游返回 `records_incomplete: true`、`estimated_missing: 2`，本服务如实透传：

> 上游标注结果不完整，估计缺失 2 条；ICTRP 导出存在已知静默缺口，零/少结果不能作为"不存在"的结论。

## 四、本轮发现并修复的两个真实缺陷

查询 PI 过程中暴露了两个此前未被测试覆盖的真实缺陷，均已修复并有回归测试。

### 缺陷 1：`get_trial_detail` 对 ChinaDrugTrials 返回页面骨架

**现象**：`get_trial_detail(recordId="chinadrugtrials:CTR20240246")` 返回：

```json
{ "sourceRecordId": "CTR20240246", "title": "CTR20263756详细信息" }
```

`title` 是站点骨架页的 `<title>` 标签，**不含任何真实试验字段**，并附警告「缺少站点内部 id 时无法构造精确详情请求；已返回页面骨架」。

**根因**：ChinaDrugTrials 详情页是 POST 目标，需要站点内部 `id`（32 位十六进制）+ `ckm_index` 两个键。这两个键**只在列表页的 `<a onclick="getDetail(this.id)" id="..." name="...">` 属性里**。原实现直接以空 `id` POST，站点返回骨架页（58,831 字节、无 `searchDetailTable`），而代码把这个骨架页当成成功结果返回。

**修复**（`src/adapters/chinadrugtrials.ts`）：

1. 新增 `fetchDetailHtml(regNo, ctx)`：先 `findListRow` 按登记号检索列表（0.3s 命中），取出 `id`/`ckm_index`，再 POST 真实详情页。
2. 新增 `findListRow(regNo, ctx)`：最多扫 5 页，按登记号精确匹配。
3. 找不到时抛 `CHINADRUGTRIALS_RECORD_NOT_FOUND`（`NO_RESULTS`），而不是返回骨架页。
4. **骨架页检测**：若响应不含 `searchDetailPartTit|searchDetailTable`，抛 `CHINADRUGTRIALS_DETAIL_UNRESOLVED`，绝不把占位页当证据返回。

### 缺陷 2：`serialize` 不可重入导致 `getDetail` 永久挂起（死锁）

**现象**：缺陷 1 的修复引入后，`getDetail` **永不 settle** —— MCP 客户端 60s 后报 `McpError: MCP error -32001: Request timed out`；直接调用时 Node 报 `Warning: Detected unsettled top-level await`。

**根因**：`serialize()` 用一条全局 Promise 链串行化对该来源的请求。修复 1 让 `getDetail` 变成**组合调用**：

```
getDetail
  └─ serialize(...)          // 外层持有链
       └─ fetchDetailHtml
            └─ findListRow
                 └─ serialize(...)   // 内层等待链释放
```

外层任务等内层完成，内层等外层释放链 —— 经典重入死锁。

**修复**：把 `serialize` 改为**可重入**（用 `requestDepth` 计数，已在序列化区间内则直接内联执行）：

```ts
let requestChain: Promise<unknown> = Promise.resolve();
let requestDepth = 0;

function serialize<T>(task: () => Promise<T>): Promise<T> {
  // Already inside a serialized section: run inline to keep the chain reentrant.
  if (requestDepth > 0) {
    requestDepth += 1;
    return task().finally(() => { requestDepth -= 1; });
  }
  const run = requestChain.then(/* … */);
  requestChain = run.catch(() => undefined);
  return run;
}
```

**回归测试**：`test/adapters.test.mjs` 新增 `chinadrugtrials: nested serialized requests do not deadlock`，用 `Promise.race` 断言组合路径必须 settle（1ms 通过）。

### 附带修复：详情页解析器重写

原 `parseDetailPage` 用文本层正则抽键值，因为值里含空格、`、`、全角标点，**抽出了垃圾键**（如 `、试验目的`、`II期临床研究`、`北京大学第三医院`）。

重写为**按真实 DOM 顺序解析**：章节 `div.searchDetailPartTit` → 子章节 `div.sDPTit2` → 标签值对 `<th>标签</th><td>值</td>`。效果对比：

| | 修复前 | 修复后 |
|---|---|---|
| 扁平字段数 | 23（大量垃圾键） | **49（全部正确）** |
| 章节 | 8（含错切） | 5（基本信息 + 一~四） |
| `试验专业题目` | ✗ | ✓ 真实标题 |
| `主要研究者` | 混在垃圾键里 | ✓ 独立 `姓名/学位/职称/电话/Email` |

## 五、验证记录

```
npx tsc -p tsconfig.json --noEmit   → 0 errors
npm test                            → 44 tests / 44 pass / 0 fail（原 43，新增 1 条死锁回归）
```

| 用例 | 结果 |
|---|---|
| `get_trial_detail(chinadrugtrials:CTR20240246)` | ✓ 真实标题 + 49 字段 + 5 章节 |
| `get_trial_detail(chinadrugtrials:CTR20222005)` | ✓ `一项评估YL201在晚期实体瘤患者中的…I期、多中心、非随机、开放性、首次人体研究` |
| `get_trial_detail(chinadrugtrials:CTR99999999)` | ✓ `NO_RESULTS` / `CHINADRUGTRIALS_RECORD_NOT_FOUND` + 修复提示 |
| 组合路径 settle | ✓ 不再挂起 |
| 全来源 `search_trials(YL201)` | ✓ 25 条，6 来源，无 unavailable |

## 六、复现命令

```bash
export CHINADRUGTRIALS_COOKIE='<合法会话 Cookie>'
UNIFIED_TRIAL_CONFIG_DIR=/tmp/utcd node dist/src/cli/main.js serve
```

```jsonc
// MCP 调用
{ "tool": "search_trials", "arguments": { "keyword": "YL201", "limit": 50 } }
{ "tool": "get_trial_detail", "arguments": { "recordId": "chinadrugtrials:CTR20240246" } }
```

详情返回后，PI 位于 `rawFields.sections["四、研究者信息"]`。
