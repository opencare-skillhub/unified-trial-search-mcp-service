# SPEC：修复文档测试数字漂移（Doc–Reality Drift Repair）

- **状态**: `SPEC_DRAFT` → 自检 `SPEC_READY`，**待用户 `SPEC_APPROVED`**
- **基线 commit**: `e9d239c1333bcd9a6baa196a8471da39dd084ed6`（当前 HEAD）
- **基线实测**: `npm test` → `tests 51 / pass 50 / fail 0 / skipped 1`（exit=0）
- **修订容忍**: 本 SPEC 声明基线；若施工前基线 commit 前移，施工时必须以当时 HEAD 的**实测数字**重新取值，并在交付报告中记录新的基线 SHA（不静默套用下方 `51/50/1`）。
- **授权边界**: 本 SPEC 已获用户确认的范围为「只修文档测试数字漂移」。commit 与 push 是两个独立授权动作，均未授权。

---

## 1. 目标 / 非目标 / 约束 / 未决问题

### 1.1 目标
消除审查发现项【中·测试套件与文档声明的通过率不符】的**唯一存活成因**：`README.md` 与 `README.zh-CN.md` 中 5 类测试数字声明（徽章、代码树注释、测试输出块、跳过说明）与实际测试数量不一致。

### 1.2 非目标（明确不做）
- 不修改任何 `.ts` / `.mjs` 源码或测试逻辑（零代码变更）。
- 不改动 `package.json` 的 `test`/`pretest` 脚本语义。
- 不新增 CI 防漂移守卫（用户已明确排除，属可选加固，见 §6 修订候选）。
- 不新增无关功能、不做大重构、不改公开 API / MCP 契约。

### 1.3 约束与假设
- **C1**：测试数量只能由**实测**取得，不得推导或估算。取值命令：`npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"`。
- **C2**：数字以 `npm test`（经由 `pretest` → `tsc` 编译）的结果为准，因为 README 宣称的入口就是 `npm test`。
- **C3**：单一被测用例是 opt-in 的（需真实 ChiCTR 语料），无该语料时恒为 `skipped 1`，故「跳过行」的措辞必须与实际跳过数一致。
- **C4**：仓库被另一会话活跃提交中。任何写入必须在施工瞬间重新校验基线 SHA 与实测数字。
- **C5**：不使用仓库中不存在的检查命令。

### 1.4 未决问题（需用户确认，均**不阻塞**本 SPEC 批准，但影响施工取值）
| # | 问题 | 暂定处置 |
|---|---|---|
| Q1 | 数字是否要写成「51 项 / 50 通过 / 1 跳过」以精确匹配，还是保留"约 50"式模糊表述？ | 采用精确数字，与实测输出逐字一致 |
| Q2 | 徽章 `tests-46 passing` 是静态 shields 徽章，每次加测试都会再次漂移。是否接受"仅修数值、不加自动同步"？ | 接受（用户已排除 CI 守卫）；作为已知残余风险记录于 §5 |
| Q3 | 另一会话若继续新增测试，本修复可能再次失效。 | 交付报告中标注基线 SHA，并给出复验命令 |

---

## 2. 架构与债务影响评估

### 2.1 受影响面
| 模块 | 是否受影响 | 说明 |
|---|---|---|
| `README.md` | **是**（仅文档） | 5 处测试数字 |
| `README.zh-CN.md` | **是**（仅文档） | 5 处测试数字 |
| `src/**`、`test/**`、`scripts/**` | 否 | 零代码变更 |
| `.github/workflows/ci.yml` | 否 | 不加守卫（用户排除） |

### 2.2 债务性质
属**文档漂移（documentation drift）**，非代码缺陷。根因是「测试数量」这一派生事实被**手工复制**进两份 README 的 5 个位置，共 10 个复制点，缺少单一事实来源。

### 2.3 真缺陷 vs 误报（审查发现项裁定）

| 发现项 | 严重度 | 裁定 | 证据 |
|---|---|---|---|
| 测试套件与文档声明的通过率不符 | 中 | **真缺陷（收窄）** | 文档写 46，实测 51（50 通过/1 跳过）。但**成因不是回归**——见下 |
| 全量功能依赖仓库外分发资产 | 中 | **设计如此，非缺陷** | SPEC §4.1 明确离线包为外部只读资产，缺资产时按契约返回 `NEEDS_SETUP` 并附引导命令，恰是"诚实契约"的预期行为。且 `test/adapters.test.mjs:138-139` 对缺语料主动 `t.skip` 而非失败 |
| dist / node_modules 入库 | 低 | **误报（证据反驳）** | 实测 `git ls-files dist \| wc -l` = **0**，`git ls-files node_modules \| wc -l` = **0**；`.gitignore` 早已含 `node_modules/` 与 `dist/`。二者仅存在于本地工作目录，从未入库 |

### 2.4 对发现项 1「exit=1」的根因裁定（重要）
审查报告称 `npm test exit=1`。实测**无法在 `npm test` 上复现**：
- 在 `5c0bc177` 与 `e9d239c` 上 `npm test` 均为 **exit=0**。
- 唯一可复现 `exit=1` 的操作是：删除 `dist/` 后**直接调用** `node --test test/*.test.mjs`，报错 `ERR_MODULE_NOT_FOUND: Cannot find module '.../dist/src/adapters/chictr-pancreatic.js'`。

根因是 `package.json` 的 npm 生命周期钩子 `"pretest": "tsc -p tsconfig.json"`：`npm test` 会先编译；**绕过 npm 直接跑 node --test 则跳过 pretest**，在无 `dist/` 的纯净检出上必然失败。因此审查方的 `exit=1` 属**测量方法伪影**，非仓库回归。

（旁证：审查报告另称 CI「3 次测试全绿」，与 `exit=1` 自相矛盾，符合伪影判断。）

---

## 3. ADR（设计与权衡）

### ADR-1：数字取值口径
- **选择**：以 `npm test` 输出为准（`tests 51 / pass 50 / skipped 1`）。
- **被否 A**：以 `node --test` 直跑为准 —— 被否，因 README 宣称入口是 `npm test`，且直跑会绕过 `pretest` 编译，是 §2.4 所述伪影来源。
- **被否 B**：改为「不写具体数字」的模糊表述 —— 被否，用户与审查方都以「46 条全通过」作为验收锚点，删除数字会丢失可验证性。
- 可逆性：高（纯文本）。后果：数字仍会随测试新增而漂移。

### ADR-2：修复范围
- **选择**：只改两份 README 的 10 个复制点，与实测对齐。
- **被否 A**：额外新增 CI 守卫，令 README 数字与实测不符时构建失败 —— 被否，**用户明确排除**；且会引入新脚本与新失败模式，超出「最小、可逆、可验证」。
- **被否 B**：把 3 项发现项都改一遍 —— 被否，其中 2 项经证据反驳为误报/设计如此（§2.3），改了反而引入无收益变更。
- 可逆性：极高（仅文档，`git revert` 即回退）。后果：无自动防再漂移能力（记为残余风险 R1）。

### ADR-3：表述一致性
- **选择**：中英两份 README 使用相同的数字与相同的「可选启用 / opt-in」语义，逐处对应。
- **被否**：只改英文 —— 被否，中文 README 同样在宣称 46，会造成新的双语文档不一致。
- 可逆性：极高。

---

## 4. 里程碑（按依赖排序）

> 全程**零代码变更**。M1 与 M2 相互独立、可并行、可各自回滚。

### M1 — 英文 README 测试数字对齐
- **文件**：`README.md`（5 处）
- **改动点**：
  1. `README.md:10` 徽章 `tests-46%20passing` → 与实测一致
  2. `README.md:302` 代码树注释 `test/  46 tests: ...` → 实测数字
  3. `README.md:315` 输出块 `# tests 46`
  4. `README.md:316` 输出块 `# pass 46`
  5. `README.md:321` 跳过说明 `45 pass / 1 skip` → 与实际通过/跳过数一致
- **验收标准（AC-M1）**：`grep -nE "46|45 pass" README.md` 不再命中任何**测试数量**语义的行；且文档声明的三元组与 `npm test` 实测的三元组逐字一致。
- **检查命令**：
  ```bash
  npm test 2>&1 | grep -E "^# (tests|pass|fail|skipped)"
  grep -nE "tests-|# tests |# pass |pass / .*skip" README.md
  ```
- **风险**：低。可能漏改某处复制点。
- **回滚**：`git checkout -- README.md`

### M2 — 中文 README 测试数字对齐
- **文件**：`README.zh-CN.md`（5 处）
- **改动点**：
  1. `README.zh-CN.md:10` 徽章 `测试-46%20通过`
  2. `README.zh-CN.md:295` 代码树注释 `test/  46 个测试：...`
  3. `README.zh-CN.md:308` 输出块 `# tests 46`
  4. `README.zh-CN.md:309` 输出块 `# pass 46`
  5. `README.zh-CN.md:314` 跳过说明 `45 通过 / 1 跳过`
- **验收标准（AC-M2）**：与 M1 同构，作用于中文文件；中英数字三元组完全相同。
- **检查命令**：
  ```bash
  grep -nE "测试-|# tests |# pass |通过 / .*跳过" README.zh-CN.md
  ```
- **风险**：低。同上。
- **回滚**：`git checkout -- README.zh-CN.md`

### M3 — 双语一致性与无回归复核
- **依赖**：M1、M2
- **动作**：确认两份 README 数字一致；确认零代码变更；重跑确定性门禁。
- **验收标准（AC-M3）**：
  - `git diff --name-only` 仅含 `README.md`、`README.zh-CN.md`
  - `npm test` exit=0 且 `fail 0`
  - `npm run typecheck` exit=0（未被波及，作为无回归证据）
  - `node scripts/check-closed-registry.mjs` 输出 `closed-registry invariant holds`
- **检查命令**：
  ```bash
  git diff --name-only
  npm test 2>&1 | tail -8; echo "EXIT=${PIPESTATUS[0]}"
  npm run typecheck; echo "EXIT=$?"
  node scripts/check-closed-registry.mjs; echo "EXIT=$?"
  ```
- **风险**：低。
- **回滚**：`git checkout -- README.md README.zh-CN.md`

---

## 5. 可追溯矩阵

| 发现项 | 裁定 | 里程碑 | 验收标准 | 验证证据 |
|---|---|---|---|---|
| [中] 测试套件与文档通过率不符 | 真缺陷（收窄为文档漂移） | M1、M2 | AC-M1、AC-M2 | `npm test` 三元组 vs `grep` README 三元组逐字一致 |
| [中] 依赖仓库外资产 | 设计如此（非缺陷） | — | 不适用 | `SPEC.md` §4.1 约定 + `test/adapters.test.mjs:138-139` 主动 `t.skip` |
| [低] dist/node_modules 入库 | **误报** | — | 不适用 | `git ls-files dist \| wc -l` = 0；`git ls-files node_modules \| wc -l` = 0；`.gitignore` 含两条 |

**零遗漏声明**：审查报告共 3 项发现项，上表逐项覆盖，各自给出裁定与证据。

**残余风险**
- **R1**：徽章与正文数字为手工复制，后续新增测试会再次漂移（ADR-2 被否方案 A 的直接后果）。缓解：M3 记录基线 SHA，复验命令已给出。
- **R2**：仓库被另一会话活跃提交，若其继续新增测试，本修复可能在交付瞬间即过期。缓解：施工时按 C4 重新取值。

---

## 6. 修订候选（Amendment candidates，**未纳入本次范围**）
- **A1**：新增 `scripts/check-readme-test-count.mjs` 并接入 CI，令 README 数字与实测不符时失败。需用户另行批准。
- **A2**：将徽章改为动态端点（如 shields 动态 JSON）以彻底消除手工复制点。需引入外部依赖，需另行评估。

---

## 7. DoR / DoD 自检

### Definition of Ready（SPEC_READY 自检）
- [x] 目标、非目标、约束、未决问题齐备（§1）
- [x] 受影响模块与债务性质已界定（§2）
- [x] 3 项发现项均已裁定为真缺陷 / 设计如此 / 误报，且附可复现证据（§2.3）
- [x] 存在真实权衡处给出 ≥2 方案与理由（§3 ADR-1/2/3）
- [x] 里程碑可独立实现/检查/复核，各含验收标准、命令、风险、回滚（§4）
- [x] 可追溯矩阵零遗漏，含残余风险（§5）
- [x] 所有检查命令均经**实测存在且可运行**（`npm test`、`npm run typecheck`、`node scripts/check-closed-registry.mjs`）
- [x] 基线 commit 与实测数字已固定（`e9d239c`，51/50/1）
- [ ] **用户 `SPEC_APPROVED`** ← 唯一未完成项，不得自批

### Definition of Done（交付前须全部满足）
- [ ] M1、M2 全部改动点完成
- [ ] M3 四条验收标准全绿
- [ ] `git diff --name-only` 仅含两份 README（零代码变更证明）
- [ ] 交付报告含：改动清单（发现项 → 文件 → 改动 → 验证）、回滚步骤、每项最终状态
- [ ] commit / push 仅在用户**单独授权**后执行

---

## 8. 门禁与授权
- 本 SPEC 自检为 `SPEC_READY`，**不等于已批准**。
- 实现前须收到用户明确的 `SPEC_APPROVED`。
- 施工完成后：先自验，再报告；**commit 与 push 各自独立授权**。
- 范围或架构若需变更，记为 §6 修订，不静默扩大。
