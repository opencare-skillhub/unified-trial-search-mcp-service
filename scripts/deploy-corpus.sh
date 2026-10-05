#!/usr/bin/env bash
#
# 一条命令完成新环境的离线语料部署。
#
# 它做四件事，每件都先检查再动手，重复执行安全（幂等）：
#   1. 检查运行环境（Node 版本、node:sqlite 可用性）
#   2. 下载并安装三个离线语料（下载 → 校验 → 解压 → 原子替换，由 CLI 保证）
#   3. 把三个语料挂载进配置
#   4. 跑 doctor 复验，并打印仍需人工完成的来源
#
# 它【不会】做的事（这是设计边界，不是没写完）：
#   - 不获取、不写入、不输出任何 Cookie
#   - 不克隆、不安装上游服务（ictrp-mcp-service / ctv-mcp-server / chictr_trials）
#   - 不绕过 robots / WAF / 验证码
#
# 用法：
#   ./deploy-corpus.sh                  # 演练：只打印将做什么
#   ./deploy-corpus.sh --apply          # 真正执行
#   ./deploy-corpus.sh --apply --corpus ctv_index      # 只装某一个
#   ./deploy-corpus.sh --help

set -euo pipefail

# ---------------------------------------------------------------- 参数解析
APPLY=0
ONLY=""
CONFIG_DIR="${UNIFIED_TRIAL_CONFIG_DIR:-}"
MIRROR=""

usage() {
  cat <<'EOF'
用法: deploy-corpus.sh [选项]

  --apply              真正执行（不加则只演练）
  --corpus <id>        只处理指定语料。可重复；默认三个全装
                       取值: chictr_pancreatic | xyb_cde_pancreatic | ctv_index
  --config-dir <目录>  配置目录（默认 $UNIFIED_TRIAL_CONFIG_DIR 或 ~/.unified-trial-mcp）
  --mirror <前缀>      用镜像替换 GitHub 前缀（内网/被墙环境）
                       会拼成 <前缀>/<corpusId>.tar.gz
  -h, --help           显示本帮助
EOF
}

CORPORA=()
while [ $# -gt 0 ]; do
  case "$1" in
    --apply)      APPLY=1; shift ;;
    --corpus)     CORPORA+=("${2:?--corpus 需要一个值}"); shift 2 ;;
    --config-dir) CONFIG_DIR="${2:?--config-dir 需要一个目录}"; shift 2 ;;
    --mirror)     MIRROR="${2:?--mirror 需要一个前缀}"; shift 2 ;;
    -h|--help)    usage; exit 0 ;;
    *) echo "未知参数: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [ ${#CORPORA[@]} -eq 0 ]; then
  CORPORA=(chictr_pancreatic xyb_cde_pancreatic ctv_index)
fi

# ---------------------------------------------------------------- 输出helpers
if [ -t 1 ]; then
  B=$'\033[1m'; DIM=$'\033[2m'; R=$'\033[0m'
  GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BLUE=$'\033[34m'
else
  B=""; DIM=""; R=""; GREEN=""; YELLOW=""; RED=""; BLUE=""
fi

step()  { printf '\n%s==> %s%s\n' "$B$BLUE" "$*" "$R"; }
ok()    { printf '  %s✓%s %s\n' "$GREEN" "$R" "$*"; }
warn()  { printf '  %s!%s %s\n' "$YELLOW" "$R" "$*"; }
fail()  { printf '  %s✗%s %s\n' "$RED" "$R" "$*"; }
info()  { printf '  %s%s%s\n' "$DIM" "$*" "$R"; }

die() { fail "$*"; exit 1; }

# 把子命令拼成可打印的一行，并保留"执行 / 只打印"两种行为。
# 注意不能用 run "$@" 包 shell 函数：printf '%q' 展开不了函数，
# 演练时会把 `cli` 这个字面量当成命令名打印出去，与实际执行不一致。
print_cmd() { printf '  %s$ unified-trial-mcp %s%s\n' "$DIM" "$*" "$R"; }

# ---------------------------------------------------------------- 0. 定位 CLI
step "0/5 检查运行环境"

if ! command -v node >/dev/null 2>&1; then
  die "找不到 node。先安装 Node.js ≥ 22.13.0：https://nodejs.org/"
fi

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
NODE_MINOR="$(node -p 'process.versions.node.split(".")[1]')"
NODE_VERSION="$(node -p 'process.versions.node')"

# node:sqlite 在 v22.5.0 引入，v22.13.0 起不再需要实验标志。
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 13 ]; }; then
  warn "Node $NODE_VERSION 低于 22.13.0。两个 SQLite 语料（ChiCTR、CTV）将无法读取。"
  warn "升级到 Node 22.13.0 或更高后重跑本脚本。"
else
  ok "Node $NODE_VERSION"
fi

if node -e 'require("node:sqlite")' >/dev/null 2>&1; then
  ok "node:sqlite 可用"
else
  warn "node:sqlite 不可用 —— 两个 SQLite 语料会被跳过，其余来源不受影响。"
fi

# 找 CLI：优先全局安装的，其次仓库内构建产物。
CLI=""
if command -v unified-trial-mcp >/dev/null 2>&1; then
  CLI="unified-trial-mcp"
  ok "使用已安装的 CLI: $(command -v unified-trial-mcp)"
elif [ -f "dist/src/cli/main.js" ]; then
  CLI="node dist/src/cli/main.js"
  ok "使用仓库内构建产物: dist/src/cli/main.js"
else
  fail "找不到 unified-trial-mcp 命令，也没有 dist/src/cli/main.js。"
  info "先执行其一："
  info "  npm install -g unified-trial-mcp"
  info "  npm install && npm run build"
  exit 1
fi

# 注意：CLI 可能是 "node dist/..." 这种带空格的字符串，所以走 eval 展开。
cli() { eval "$CLI" '"$@"'; }

CONFIG_ARGS=()
if [ -n "$CONFIG_DIR" ]; then
  CONFIG_ARGS=(--config-dir "$CONFIG_DIR")
fi

# ---------------------------------------------------------------- 1. 前置诊断
step "1/5 部署前诊断"
cli doctor "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" >/dev/null 2>&1 || true
info "（doctor 退出码 2 表示全新环境，属正常，继续）"

# ---------------------------------------------------------------- 2. 装语料
step "2/5 下载并安装离线语料（共 ${#CORPORA[@]} 个）"

for corpus in "${CORPORA[@]}"; do
  printf '\n  %s── %s%s\n' "$B" "$corpus" "$R"

  # 先演练：CLI 会打印 URL / 字节数 / sha256 / 分发依据，不改动任何东西。
  if [ -n "$MIRROR" ]; then
    URL="${MIRROR%/}/${corpus}.tar.gz"
    info "使用镜像：$URL"
    cli fetch-corpus --corpus "$corpus" --url "$URL" "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" || \
      die "$corpus 演练失败。检查镜像地址或网络。"
  else
    cli fetch-corpus --corpus "$corpus" "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" || \
      die "$corpus 演练失败。该语料可能尚未发布；用 fetch-corpus --print-url 看预期地址。"
  fi

  if [ "$APPLY" -eq 1 ]; then
    if [ -n "$MIRROR" ]; then
      cli fetch-corpus --corpus "$corpus" --url "$URL" --apply "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" \
        || die "$corpus 安装失败。已安装的数据未被改动，可安全重试。"
    else
      cli fetch-corpus --corpus "$corpus" --apply "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" \
        || die "$corpus 安装失败。已安装的数据未被改动，可安全重试。"
    fi
    ok "$corpus 已安装"
  else
    info "（演练：未下载）"
  fi
done

# ---------------------------------------------------------------- 3. 挂载
step "3/5 挂载语料"

if [ "$APPLY" -eq 0 ]; then
  info "演练模式：下面这些 configure 命令将在 --apply 时执行"
fi

MOUNT_ARGS=()

for corpus in "${CORPORA[@]}"; do
  # 路径形状由 CLI 自己算，避免脚本里再写一遍规则而写错。
  json="$(cli fetch-corpus --corpus "$corpus" --json "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" 2>/dev/null)" || {
    warn "无法读取 $corpus 的安装路径，跳过挂载"
    continue
  }

  corpus_dir="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(o.corpusDir)})')"
  db_path="$(printf '%s' "$json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s.slice(s.indexOf("{")));process.stdout.write(o.dbPath)})')"

  case "$corpus" in
    chictr_pancreatic)
      # --chictr-corpus 指向【文件】
      MOUNT_ARGS+=(--chictr-corpus "$db_path")
      info "chictr_pancreatic → --chictr-corpus $db_path"
      ;;
    xyb_cde_pancreatic)
      # --xyb-archive 指向【数据包的父目录】。指向目录内容本身会导致
      # 安装看似成功、查询时报 NO_ARCHIVE_PACKAGES。
      MOUNT_ARGS+=(--xyb-archive "$corpus_dir")
      info "xyb_cde_pancreatic → --xyb-archive $corpus_dir"
      ;;
    ctv_index)
      # --ctv-database 指向【文件】
      MOUNT_ARGS+=(--ctv-database "$db_path")
      info "ctv_index → --ctv-database $db_path"
      ;;
    *) warn "未知语料 $corpus，跳过挂载" ;;
  esac
done

if [ ${#MOUNT_ARGS[@]} -gt 0 ]; then
  print_cmd configure "${MOUNT_ARGS[@]}" ${CONFIG_DIR:+--config-dir "$CONFIG_DIR"}
  if [ "$APPLY" -eq 1 ]; then
    cli configure "${MOUNT_ARGS[@]}" "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" \
      || die "挂载失败。语料已安装，可单独重跑上面的 configure 命令。"
    ok "已写入配置"
  else
    info "（演练：未写入配置）"
  fi
else
  warn "没有可挂载的语料"
fi

# ---------------------------------------------------------------- 4. 复验
step "4/5 复验"
cli doctor "${CONFIG_ARGS[@]+"${CONFIG_ARGS[@]}"}" || DOCTOR_RC=$?
DOCTOR_RC="${DOCTOR_RC:-0}"

# ---------------------------------------------------------------- 5. 人工待办
step "5/5 仍需人工完成的来源"

cat <<'EOF'

  下面这些来源本脚本【刻意不自动处理】。跳过它们不影响已装好的离线语料，
  检索时会如实报 NOT_QUERIED / NEEDS_SETUP，不会伪装成"没有结果"。

  ── ChinaDrugTrials 在线（需要会话 Cookie）
     方式一（自动，仅一次公开入口页访问，不绕过任何验证）：
       unified-trial-mcp configure --cookie-from-entry-page
     方式二（人工，站点要求登录态时）：在浏览器对站内请求「复制为 cURL」，然后：
       unified-trial-mcp configure --cookie-from-curl '<粘贴完整 cURL>'
     两者都写入 <配置目录>/cookie.env（权限 0600）。

  ── ICTRP 在线（需要上游 Python 服务）
       unified-trial-mcp configure --ictrp-bundle <ictrp-mcp-service 目录>

  ── ChiCTR 在线 / CTV 在线
       unified-trial-mcp configure --chictr-mcp-server <chictr_trials 目录>
       unified-trial-mcp configure --ctv-mcp-server <ctv-mcp-server 目录>

  这些上游是独立的第三方/社区服务，各自需要运行时与依赖。本脚本不去
  git clone 也不去 npm install 它们 —— 让一个检索服务在你机器上自动执行
  上游代码，风险远大于它省下的那几分钟。请自行确认来源后再安装。

EOF

case "$DOCTOR_RC" in
  0) ok "全部来源就绪" ;;
  1) warn "部分来源就绪 —— 离线语料可用，上面列出的在线来源需要人工配置" ;;
  2) warn "尚无可用来源（在线来源未配置属正常；若离线语料也未就绪，请看上面 doctor 的输出）" ;;
esac

if [ "$APPLY" -eq 0 ]; then
  printf '\n%s这是演练，未做任何改动。确认无误后重跑并加 --apply。%s\n' "$B" "$R"
fi

# 退出码语义：0 = 本脚本的部署动作全部成功。
# 不直接沿用 doctor 的退出码 —— 全新环境里在线来源本来就没配，
# doctor 必然返回 2，如果照搬，`deploy-corpus.sh --apply && 后续步骤`
# 会在一切顺利的情况下断掉。来源就绪度已经打印在上面，由人判断。
exit 0
