/**
 * Explicit bootstrap (SPEC 4.1 / ADR-006).
 *
 * Bootstrap prepares what is *mechanically* preparable and reports what is not.
 * Hard limits, by design:
 *
 *  - It never obtains, writes, or prints a Cookie.
 *  - It never launches an interactive browser or solves a CAPTCHA/WAF challenge.
 *  - It never downloads or ships third-party data on the user's behalf.
 *  - It is idempotent: an already-ready source is reported as skipped, and
 *    nothing already working is rolled back or overwritten.
 *  - Default is a dry run; `--apply` is required to touch anything.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

import type { ResolvedPaths, SourceId } from '../core/types.js';
import { checkPathReadable } from '../core/config.js';

export type BootstrapStatus = 'ready' | 'planned' | 'applied' | 'skipped' | 'manual' | 'blocked';

export interface BootstrapStep {
  sourceId: SourceId | 'runtime' | 'offline';
  status: BootstrapStatus;
  action: string;
  detail?: string;
  /** A command the *user* may run deliberately; never executed implicitly. */
  command?: string;
}

export interface BootstrapOutcome {
  applied: boolean;
  steps: BootstrapStep[];
}

export interface BootstrapOptions {
  paths: ResolvedPaths;
  sourceIds?: SourceId[];
  apply: boolean;
  dryRun: boolean;
  withCtvIndex: boolean;
  maxPages: number;
  keyword?: string;
}

async function exists(target: string | undefined): Promise<boolean> {
  if (!target) return false;
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Non-destructive: creates a directory only when it is missing. */
async function ensureDir(target: string, apply: boolean): Promise<BootstrapStep> {
  if (await exists(target)) {
    return { sourceId: 'runtime', status: 'skipped', action: `目录已存在：${target}` };
  }
  if (!apply) {
    return { sourceId: 'runtime', status: 'planned', action: `将创建目录：${target}` };
  }
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  return { sourceId: 'runtime', status: 'applied', action: `已创建目录：${target}` };
}

export async function runBootstrap(options: BootstrapOptions): Promise<BootstrapOutcome> {
  const { paths, apply } = options;
  const steps: BootstrapStep[] = [];
  const wanted = options.sourceIds ? new Set(options.sourceIds) : undefined;

  const include = (id: SourceId): boolean => !wanted || wanted.has(id);

  // 1. Runtime directories (always safe, always idempotent).
  steps.push(await ensureDir(paths.configDir, apply));
  steps.push(await ensureDir(paths.workDir, apply));

  // 2. Offline corpus / archive assets: verify readability and never fetch data.
  const offline: Array<[SourceId, string | undefined, 'file' | 'dir', string]> = [
    ['chictr_pancreatic_archive', paths.chictrCorpus, 'file', 'ChiCTR 胰腺癌离线语料（SQLite）'],
    ['xyb_chinadrugtrials_archive', paths.xybArchive, 'dir', '小胰宝 ChinaDrugTrials 归档目录'],
    ['chinadrugtrials', paths.chinadrugtrialsArchive, 'dir', 'ChinaDrugTrials 受控归档目录'],
  ];
  for (const [sourceId, target, kind, label] of offline) {
    if (!include(sourceId)) continue;
    if (!target) {
      steps.push({
        sourceId,
        status: 'manual',
        action: `${label}未配置`,
        detail: '该来源需要人工提供的本地数据；bootstrap 不会代为下载或抓取。',
        command: `unified-trial-mcp configure --${sourceId === 'chictr_pancreatic_archive' ? 'chictr-corpus' : sourceId === 'xyb_chinadrugtrials_archive' ? 'xyb-archive' : 'chinadrugtrials-archive'} <绝对路径>`,
      });
      continue;
    }
    const check = await checkPathReadable(target, paths.evidenceRoots, kind);
    steps.push(
      check.ok
        ? { sourceId, status: 'ready', action: `${label}可读：${target}` }
        : { sourceId, status: 'blocked', action: `${label}不可用：${target}`, detail: `${check.reasonCode}：${check.message}`, command: undefined },
    );
  }

  // 3. Upstream MCP services: check the build, never install silently.
  const upstreams: Array<[SourceId, string | undefined, 'file' | 'dir', string, string]> = [
    ['ictrp', paths.ictrpBundle, 'dir', 'ICTRP 上游服务目录', 'npm install && npm run build'],
    ['ctv', paths.ctvMcpServer, 'dir', 'CTV 上游服务目录', 'npm install && npm run build'],
    ['chictr_online', paths.chictrMcpServer, 'dir', 'ChiCTR 在线服务目录', 'npm install && npm run build'],
  ];
  for (const [sourceId, root, kind, label, buildCommand] of upstreams) {
    if (!include(sourceId)) continue;
    if (!root) {
      steps.push({
        sourceId,
        status: 'manual',
        action: `${label}未配置`,
        detail: '需要人工准备上游服务与运行时；bootstrap 不会安装第三方依赖或联网下载代码。',
      });
      continue;
    }
    const check = await checkPathReadable(root, paths.evidenceRoots, kind);
    if (!check.ok) {
      steps.push({ sourceId, status: 'blocked', action: `${label}不可用：${root}`, detail: `${check.reasonCode}：${check.message}` });
      continue;
    }
    const built =
      (await exists(path.join(root, 'dist/index.js'))) ||
      (await exists(path.join(root, 'npm/dist/index.js'))) ||
      (await exists(path.join(root, 'dist/src/index.js')));
    steps.push(
      built
        ? { sourceId, status: 'ready', action: `${label}已就绪：${root}` }
        : {
            sourceId,
            status: 'manual',
            action: `${label}存在但未构建`,
            detail: '本服务不会自动安装上游依赖或执行构建。',
            command: `(cd ${root} && ${buildCommand})`,
          },
    );
  }

  // 4. Cookie-gated source: bootstrap never obtains a Cookie, but a new
  //    environment must not be left without a concrete next step, so the
  //    automatic one-shot command is named here as `command` (never executed).
  if (include('chinadrugtrials')) {
    const configured = Boolean(paths.chinadrugtrialsArchive);
    steps.push({
      sourceId: 'chinadrugtrials',
      status: 'manual',
      action: 'ChinaDrugTrials 会话 Cookie',
      detail:
        '该来源需要会话 Cookie。取得方式一（自动，一次公开入口页访问，不绕过任何验证）：' +
        `unified-trial-mcp configure --cookie-from-entry-page --config-dir ${paths.configDir}；` +
        '方式二（人工，站点需要登录态或方式一失败时）：在浏览器中对站内请求「复制为 cURL」，' +
        `再运行 configure --cookie-from-curl '<cURL>' --config-dir ${paths.configDir}。` +
        '两者都写入 <配置目录>/cookie.env（0600）。' +
        'bootstrap 本身不会获取、写入或输出该值，也不会绕过验证码/WAF。' +
        (configured ? '' : ' 另外：受控归档目录尚未配置，请运行 configure --chinadrugtrials-archive <绝对路径>。'),
      command: `unified-trial-mcp configure --cookie-from-entry-page --config-dir ${paths.configDir}`,
    });
  }

  // 5. Optional CTV index build — only when explicitly requested.
  if (options.withCtvIndex && include('ctv')) {
    if (!paths.ctvMcpServer) {
      steps.push({ sourceId: 'ctv', status: 'blocked', action: '未配置 CTV 上游服务目录，无法构建索引' });
    } else if (!apply) {
      steps.push({
        sourceId: 'ctv',
        status: 'planned',
        action: `将执行 sitemap 同步构建本地索引（maxShards=1）`,
        detail: '索引构建会访问上游站点；仅在 --apply 时执行。',
      });
    } else {
      steps.push({
        sourceId: 'ctv',
        status: 'planned',
        action: 'CTV 索引构建需通过 MCP 工具 sync_ctv_index 执行',
        detail: '为避免绕过上游节流与 robots 约束，bootstrap 不直接调用上游网络接口。',
      });
    }
  }

  return { applied: apply, steps };
}
