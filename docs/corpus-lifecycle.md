# 离线语料的完整生命周期

本文档描述三个离线语料从**打包 → 上传 Release → 自动化部署（下载 → 校验 → 解压 → 原子替换 → 挂载 → 检索）**
的全过程，以及**数据更新后重新发布新版本**的操作步骤。

面向两类读者：

- **发布者**（社区维护者）：每两个月拿到新数据后，如何打包并发布一个新的版本；
- **使用者**：如何在冷启动环境下把语料装好并跑通检索。

---

## 1. 三个语料与完整 URL

| 语料 | 内容 | 字节数 | 挂载参数 | 依据 |
|---|---|---|---|---|
| `chictr_pancreatic` | ChiCTR 胰腺癌离线语料（468 条，SQLite） | 25,381,264 | `--chictr-corpus` | `upstream_public` |
| `xyb_cde_pancreatic` | 小胰宝 CDE 胰腺癌社区归档（710 文件） | 11,032,155 | `--xyb-archive` | `community_owned` |
| `ctv_index` | CTV（Veeva）本地检索索引（1434 条 studies，FTS5） | 23,964,370 | `--ctv-database` | `community_owned` |

### 完整 URL（可直接复制）

```
chictr_pancreatic    https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz
xyb_cde_pancreatic   https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz
ctv_index            https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz
```

### 摘要（sha256 全文，校验以此为准）

```
chictr_pancreatic    abbfc53ba346741be418c143f67a53ea83bb47114495bdb1a0d05ccb539f78af
xyb_cde_pancreatic   d1ccdac0ef5462a62bf43a5ec5b341ef7f0cd08a297d138d9c2617c757b482fb
ctv_index            41f07ea5a0b7c1b88e43c940de0e8491b109cd230aea78d63e9a0d331d0d827f
```

`corpora/manifest.json` 是唯一权威来源（URL、字节数、sha256、`version`、`basis` 都记在里面），
本节列出的值应与它逐字一致。若两者不一致，**以清单为准**，说明文档该更新了。

### URL 的构造规则

```
https://github.com/<owner>/<repo>/releases/download/<corpusId>-<version>/<corpusId>.tar.gz
```

其中 `<corpusId>-<version>` 既是下载路径的一段，也是 Release 的 **tag**（例如 `ctv_index-2026-10-05`）。
所以**版本号一旦发布就不能改**——改了 URL 就 404。

---

## 2. 使用者路径：自动化部署

### 2.1 最省事：让 bootstrap 全部代劳

新环境装完 npm 包之后，**一条命令**就把三个语料装齐并挂好，不需要你手工挑语料、也不需要
手工跑 `configure`：

```bash
unified-trial-mcp bootstrap               # 先看计划（dry-run，不动任何东西）
unified-trial-mcp bootstrap --apply       # 执行
unified-trial-mcp doctor                  # 复验
```

`bootstrap --apply` 对每个可公开获取的语料依次执行 2.1 描述的六步（下载 → 校验字节数 →
校验 sha256 → 解压到暂存 → 校验内容 → 原子替换），**紧接着把装好的路径写进配置**，
所以跑完就是可用状态。它只处理公开发布的语料；需要 Cookie 或需要你自备上游服务的来源，
它只打印下一条命令（见 2.4）。

也可以用仓库里的幂等脚本，适合放进部署流水线：

```bash
./scripts/deploy-corpus.sh --apply                      # 三个语料全装
./scripts/deploy-corpus.sh --apply --corpus ctv_index   # 只装某一个
./scripts/deploy-corpus.sh --apply --mirror https://内网镜像/
```

脚本比 `bootstrap --apply` 多两件事：**逐个演练**（每个语料先打印 URL、字节数、sha256 再下载）
与**镜像支持**（`--mirror` 整体替换 GitHub 前缀，也接受 `file://` 本地 tar 包）。
它的退出码 `0` 表示脚本自身的部署动作全部成功，**不**沿用 `doctor` 的退出码 —— 全新环境的
在线来源本来就没配，照搬会让 `&&` 串接在一切顺利时断掉。

### 2.2 单独装某一个语料

```bash
unified-trial-mcp fetch-corpus --corpus ctv_index --apply
```

内部依次执行六步，**任一步失败都不会破坏你已有的数据**：

| 步骤 | 动作 | 失败时的行为 |
|---|---|---|
| 1 | 下载到临时文件 | 保留原数据；重试 3 次 |
| 2 | 校验字节数 | 保留原数据 |
| 3 | 校验 sha256 | 保留原数据 |
| 4 | 解压到临时目录 | 保留原数据；清理临时目录 |
| 5 | 校验内容（必需文件 / SQLite 表） | 保留原数据 |
| 6 | **原子替换**（`rename`） | 旧数据在新数据就位后才删除 |

先去掉 `--apply` 就是演练，只打印将访问的 URL、字节数、摘要与分发依据：

```bash
unified-trial-mcp fetch-corpus --corpus ctv_index          # dry run
```

### 2.3 三个语料依次安装

```bash
unified-trial-mcp fetch-corpus --corpus chictr_pancreatic --apply
unified-trial-mcp fetch-corpus --corpus xyb_cde_pancreatic --apply
unified-trial-mcp fetch-corpus --corpus ctv_index --apply
```

默认装到 `~/.unified-trial-mcp/corpora/<corpusId>/`。

### 2.4 挂载（bootstrap 已代劳，这里是手工场景）

> 走 2.1 的 `bootstrap --apply` 时**不需要**这一步 —— 它会用下面这张表的规则把路径写进配置。
> 本节适用于你单独跑了 `fetch-corpus`、或想手工指定别处的语料。

三个语料的**目录形状不同**，因为 `configure` 参数指向的东西不同：

| 语料 | 参数语义 | 挂载命令 |
|---|---|---|
| `chictr_pancreatic` | 指向**文件** | `configure --chictr-corpus ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db` |
| `xyb_cde_pancreatic` | 指向**数据包的父目录** | `configure --xyb-archive ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic` |
| `ctv_index` | 指向**文件** | `configure --ctv-database ~/.unified-trial-mcp/corpora/ctv_index/ctv.db` |

```bash
unified-trial-mcp configure \
  --chictr-corpus   ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db \
  --xyb-archive     ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic \
  --ctv-database    ~/.unified-trial-mcp/corpora/ctv_index/ctv.db
```

安装后的实际目录形状：

```
corpora/chictr_pancreatic/chictr_pancreatic.db   <- 文件直接在目录下
corpora/ctv_index/ctv.db                         <- 文件直接在目录下
corpora/xyb_cde_pancreatic/胰腺癌/summary.json    <- 保留包目录一层
```

> **装错不会在安装时报错，而是在查询时才炸。**
> 把 `xyb_cde_pancreatic` 装成包内容直接位于根目录，检索时会报
> `NEEDS_SETUP / NO_ARCHIVE_PACKAGES`（"json、logs、raw、word 均不完整"）。
> 适配器是在你给的目录**下面一层**找含 `summary.json` 的子目录。

### 2.5 验证

```bash
unified-trial-mcp doctor
```

每个就绪来源打印 `OK`；离线来源会额外打印**数据截止日**与推导依据。退出码：
`0` 全部就绪 / `1` 部分未就绪 / `2` 无可用来源。

### 2.6 走镜像或离线机房

摘要校验依然生效，只是换了来源：

```bash
unified-trial-mcp fetch-corpus --corpus ctv_index --url https://your-mirror/ctv_index.tar.gz --apply
unified-trial-mcp fetch-corpus --corpus ctv_index --url file:///srv/airgap/ctv_index.tar.gz --apply
```

完全手工的路径：下载 → `shasum -a 256` 对照清单 → `tar -xzf` → `configure` 挂载。

### 2.7 一次性下齐（脚本化部署）

```bash
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz
shasum -a 256 *.tar.gz    # 与 corpora/manifest.json 逐条比对
```

---

## 3. 发布者路径：打包与发布

### 3.1 前置：数据在哪里

| 语料 | 默认数据源 | 必需条目 |
|---|---|---|
| `chictr_pancreatic` | `~/Downloads/chictr_trials/data` | `chictr_pancreatic.db` |
| `xyb_cde_pancreatic` | `~/Downloads/xyb-chinadrugtrials-data/output` | `胰腺癌/` |
| `ctv_index` | `~/.ctv-mcp` | `ctv.db` |

数据源不在默认位置时用 `--source <绝对路径>` 指定。路径**不写进清单**，因为清单里的 URL 必须对所有人通用。

### 3.2 打包（默认 dry run）

```bash
node scripts/pack-corpus.mjs --corpus ctv_index
```

输出文件数、字节数、sha256 与 `basis`，**不写清单**。确认无误后加 `--write-manifest`。

### 3.3 归档是可复现的

同一份数据、同一个版本号，**两次打包的 sha256 完全相同**（gzip 头 mtime 固定为 0，遍历顺序确定）。
tar 条目保留真实 mtime —— 这是刻意的：用户要靠它核对数据截止日，抹成同一个时间会误导人。

> 用 `tar` 命令手工打包会得到**不同且不可复现**的结果（macOS 的 bsdtar 不支持 `--mtime`），
> 所以请一律用 `pack-corpus.mjs`。

### 3.4 发布流程

```bash
# 1) 打包并写入清单
node scripts/pack-corpus.mjs --corpus ctv_index --write-manifest

# 2) 创建 Release 并上传（tag 必须与清单里的 version 一致）
gh release create ctv_index-2026-10-05 dist-release/ctv_index.tar.gz \
  --title "CTV（Veeva）本地检索索引 2026-10-05" --notes-file /tmp/relnotes.md

# 3) 核对 GitHub 记录的摘要与清单一致（顺序很重要：先传后提交）
gh release view ctv_index-2026-10-05 --json assets \
  --jq '.assets[] | "\(.name) \(.size) \(.digest)"'

# 4) 提交清单
git add corpora/manifest.json && git commit -m "data: publish ctv_index 2026-10-05" && git push
```

**为什么顺序不能反**：清单里的 sha256 是 `fetch-corpus` 的强制校验依据。
如果先提交清单再上传资产，中间这段时间所有用户都会校验失败。
先传资产 → 核对 GitHub 记录的 digest 与清单一致 → 再提交清单，
保证「清单里的东西一定已经能下载到」。

### 3.5 验证发布成功

```bash
# 换一台机器（或清空 ~/.unified-trial-mcp/corpora）走一遍真实流程
unified-trial-mcp fetch-corpus --corpus ctv_index --apply
```

---

## 4. 数据更新：每两个月怎么发新版本

### 4.1 版本号规则

版本号决定 Release tag 与下载 URL：

```
<corpusId>-<version>
version = YYYY-MM-DD          默认取当天
        = YYYY-MM-DD-NN       同一天需要发第二次时用后缀（NN 从 01 开始）
```

**默认为什么不够**：两个版本号相同的归档会抢占同一个 tag，`gh release create` 会直接拒绝。
两个月一更通常不会撞，但「发布后发现数据有误、当天要重发」100% 会撞 —— 这就是后缀存在的理由。

### 4.2 定期更新（假设 2026-12-05 拿到新数据）

```bash
# 1) 打包新版本（显式指定版本号，不要依赖当天日期）
node scripts/pack-corpus.mjs --corpus chictr_pancreatic \
  --source /path/to/updated/chictr_trials/data \
  --version 2026-12-05 --write-manifest

# 2) 新 tag、新 URL，旧版本原样保留
gh release create chictr_pancreatic-2026-12-05 dist-release/chictr_pancreatic.tar.gz \
  --title "ChiCTR 胰腺癌离线语料 2026-12-05" --notes-file /tmp/relnotes.md

# 3) 核对 digest → 提交清单 → 推送
gh release view chictr_pancreatic-2026-12-05 --json assets --jq '.assets[].digest'
git add corpora/manifest.json && git commit -m "data: publish chictr_pancreatic 2026-12-05" && git push
```

用户端如何拿到新版，取决于**你发的是哪条线** —— 见下一节，这是最容易出错的地方。

### 4.2.1 两条发布线：数据库走 git，客户端走 npm

`corpora/manifest.json` **同时活在两个地方**：git 仓库里一份，每个已安装的 npm 包里也有一份快照
（`src/cli/corpus.ts:37` 的 `MANIFEST_PATH` 指向包内的 `corpora/manifest.json`）。
`fetch-corpus` 读的是**自己所在包里的那一份**，没有任何远程拉取清单的机制。

后果很直接：**只推 git、不发新 npm 版本，老用户永远拿不到新数据库。**

实测（pack 出 0.3.0 装好后，把仓库里的清单改成新大小）：

| 操作 | 已装 0.3.0 的用户跑 `fetch-corpus` 看到 |
|---|---|
| 仓库清单改为新版 | 仍然是旧值 `23964370`（读包内快照） |

所以两条线要**一起发**：

```
新数据库就绪
   │
   ├─ ① node scripts/pack-corpus.mjs --corpus <id> --version <YYYY-MM-DD> --write-manifest
   │
   ├─ ② gh release create <id>-<version> dist-release/<id>.tar.gz       ← 资产先上传
   │
   ├─ ③ gh release view <id>-<version> --json assets --jq '.assets[].digest'
   │      比对清单里的 sha256 是否一致
   │
   ├─ ④ git add corpora/manifest.json && git commit -m "data: publish <id> <version>" && git push
   │      ↑ 到这一步「没升级 npm 版本」的老用户仍然拿不到新库
   │
   └─ ⑤ npm version patch && npm publish && git push --follow-tags
          ↑ 老用户从这里开始才能拿到新库
```

**版本号怎么挑**：数据库更新用 `npm version patch`（0.3.0 → 0.3.1）即可 —— 客户端代码没变，
变的只是包内清单。想发功能更新就用 `minor`。清单版本（`<corpusId>-<YYYY-MM-DD>`）与 npm 版本是**两套独立编号**，不要混。

也正因为如此：**改清单的提交必须与 npm 发布同批**。若只提交清单就收工，
用户会以为"更新好了"，实际拿到的是旧地址。

### 4.2.2 用户端一条命令完成升级

老用户（已装旧版 npm 包）升级分两段，第二段只是重跑同一条命令：

```bash
# 1) 升级客户端（拿到新清单）
npm install -g unified-trial-mcp@latest

# 2) 重新安装语料（fetch-corpus 会读新清单里的新 URL/sha256，自动下新库）
unified-trial-mcp fetch-corpus --corpus chictr_pancreatic --apply
```

`fetch-corpus --apply` 是幂等的：目标目录里已有旧库时会走「下载 → 校验 sha256 → 解压到暂存 → 原子替换」，
失败则保留旧库不动。所以**重跑是安全的**，不需要先手工删除旧库。

用 `bootstrap --apply` 可以一次把三个语料都升到清单里的最新版：

```bash
unified-trial-mcp bootstrap --apply
```

只验不做（先看重不重要）用 `fetch-corpus --corpus <id> --print-url` 看将要下载的地址，
或 `--json` 拿结构化字段（`corpusId/url/bytes/sha256/destDir/corpusDir/dbPath/applied/steps`）。

**发布前自检**：`npm test` 里有一条守卫 `npm: the package version moves when the published corpus list moves`，
它会在清单已改但未提交时直接失败，把「忘了发」挡在 publish 之前。

### 4.3 同日修正（发布后发现问题要重发）

```bash
node scripts/pack-corpus.mjs --corpus ctv_index --version 2026-10-05-02 --write-manifest
gh release create ctv_index-2026-10-05-02 dist-release/ctv_index.tar.gz --title "CTV 索引 2026-10-05-02"
```

### 4.4 更新时的注意事项

- **旧 Release 不要删。** 有人可能还锁在旧版本上；删了他们的 URL 就 404。清单指向哪个版本，用户就拿哪个版本。
- **清单里每个语料只有一个当前版本。** `fetch-corpus` 按语料 id 取清单条目，所以发布新版本 = 覆盖该条目的 `url`/`bytes`/`sha256`/`version`，旧版本仍可通过完整 URL 手动下载。
- **`basis` 不可缺省。** 缺少 `basis` 的资产会被 `fetch-corpus` 直接拒绝（`MANIFEST_BASIS_MISSING`）。这是刻意的：不允许有人把"看起来可以分发"的东西塞进来而不说明凭什么可以分发。
- **缺条目会在打包前直接失败。** 脚本启动时先检查该语料声明的每个必需条目（如 `胰腺癌/`、`chictr_pancreatic.db`）是否存在；缺一个就立刻退出，不会产出"成功但不完整"的归档。
- **更新后确认数据截止日变了。** 装完跑 `doctor`，离线来源会打印 `数据截止 <日期>`；若仍显示旧日期，说明装错了来源或缓存未刷新。
- **改了清单一定要发新 npm 版本。** 见 §4.2.1 —— 老用户读的是自己包里的清单快照，不发新版就永远停在旧地址。
- **两套版本号别混。** 清单里的 `<corpusId>-<YYYY-MM-DD>` 决定 Release tag 与下载 URL；npm 的 `0.3.0` 决定客户端包。同一个数据库更新通常两者都要动。

### 4.5 数据截止日必须"从数据推导"

三个语料的 `dataCutoff` 都由**内容自身的时间戳**推导，绝不硬编码：

| 语料 | 推导依据 |
|---|---|
| `chictr_pancreatic` | 语料内 `trials.updated_at` 与 `crawl_log` 最大时间戳取较新者 |
| `xyb_cde_pancreatic` | 各包内**记录级** `scrape_time` 与 `summary.json` 声明取较新者 |
| `ctv_index` | 索引内 `sync_runs` 记录的同步时间 |

实测中存在 `summary.json` 声明时间**比记录中最新一条更新**的情况（声明 2026-09-29，实际记录最新 2026-09-29T07:59），
因此以**记录级时间**为准。多周抓取的跨度会额外输出 warning，而不是抹平成单一时间点。

---

## 5. 排障

| 症状 | 原因与处置 |
|---|---|
| `DOWNLOAD_HTTP_ERROR 404` | tag 或资产名与清单不符，或资产尚未上传。核对 `gh release view <tag>` |
| `SHA256_MISMATCH` / `SIZE_MISMATCH` | 下载内容与清单不符。**原有数据未改动**。重试；持续失败说明资产被替换，需重新打包并更新清单 |
| `DOWNLOAD_FAILED`（连接超时） | 网络不可达（部分网络访问 GitHub 443 会被拦截）。用 `--url` 指向镜像或 `file://` |
| `CORPUS_NOT_IN_MANIFEST` | 该语料尚未发布，或清单为空 |
| `MANIFEST_BASIS_MISSING` | 清单条目缺少 `basis`。合法值只有 `upstream_public` 与 `community_owned` |
| `ARCHIVE_LAYOUT_UNEXPECTED` | 归档顶层直接是数据包内容，缺少包目录层级；重新打包 |
| `INSTALLED_ARCHIVE_UNUSABLE` | 解压后没有可用数据包（每个包都需 `summary.json` + `json/`） |
| 来源报 `NO_ARCHIVE_PACKAGES` | **多半是挂载路径层级错了**：`--xyb-archive` 要指向数据包的**父目录** |
| 来源报 `no such table` | `.db` 能打开但不是本服务期望的库；检查是否把语料装成了另一个 |
| 来源报 `CTV_MCP_NOT_CONFIGURED` | 语料只有索引，**不含**上游 `ctv-mcp-server` 代码，仍需单独提供并构建 |
| 来源报 `NODE_SQLITE_UNAVAILABLE` | Node < 22.13。升级 Node，其余来源不受影响 |

---

## 6. 分发依据（为什么这三个可以分发）

`corpora/manifest.json` 的每个条目都必须声明 `basis`，合法值只有两个，**两者刻意分开、不得互相援引**：

| `basis` | 含义 | 适用语料 |
|---|---|---|
| `upstream_public` | 上游公开、可匿名下载的数据集 | `chictr_pancreatic` |
| `community_owned` | 社区自采/自建成果，权利人对该成果自身拥有分发权 | `xyb_cde_pancreatic`、`ctv_index` |

关键在于：`community_owned` 的依据是**社区对自己成果的权利**，
**与上游站点是否需要凭证、是否禁止抓取无关**。
上游 CDE 需要 Cookie 会话、`ctv.veeva.com/robots.txt` 禁止抓取 `/study-search` ——
这些都不能拿来论证社区自己那份成果可以分发，反过来"社区能分发"也不代表上游数据是公开的。

把两者混为一谈，等于悄悄废掉「本服务绝不代取需凭证数据」这条底线。

- 需要凭证、需要绕过 robots/WAF/验证码、需要用户身份的数据，**永不自动获取**；
- 权利人确认全部可分发后，打包脚本**不得擅自剥离字段**（`ctv_index` 含研究者联系方式，已确认原样分发）；
- 分发的每个资产都要在清单里留下 `note`，说明来源，使后来者能看出它凭什么被允许分发，而不是只看到一个 URL。

---

> 小胰宝社区，依托AI+人文，全心全意为患者/家属服务！
