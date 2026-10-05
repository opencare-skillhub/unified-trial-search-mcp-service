/**
 * ChinaDrugTrials session Cookie acquisition (explicit, one-shot).
 *
 * ## Why this module exists
 *
 * The site hands out two anti-bot tickets (`FSSBBIl1UgzbN7N80S` / `...T`) on a
 * plain GET of its public landing page. Without them every search returns an
 * empty-body challenge page, which an adapter could easily mistake for "no such
 * trial". New-environment setup therefore has to be able to obtain them, or the
 * source is unusable.
 *
 * ## Why this is not a WAF bypass
 *
 * These tickets are *given to us* by the site for a normal visit. Fetching them
 * is one ordinary GET of a public page: no CAPTCHA is solved, no challenge is
 * defeated, no rate limit is evaded, and no login credential is forged. That is
 * categorically different from defeating an access control, which this project
 * never does.
 *
 * ## Hard limits
 *
 *  - Never runs implicitly. Only an explicit `configure --cookie-from-entry-page`.
 *  - `doctor` and `bootstrap` never call this; they only *guide* the user.
 *  - Never reads another project's config file or a real browser profile.
 *  - Never stores the value in the config file; it goes to the env file, mode 0600.
 *  - Validates before saving, and reports precisely why a fetch failed.
 */

import path from 'node:path';
import { promises as fs } from 'node:fs';

export const LANDING_URL = 'https://www.chinadrugtrials.org.cn/clinicaltrials.prosearch.dhtml';
export const SEARCH_URL = 'https://www.chinadrugtrials.org.cn/clinicaltrials.searchlist.dhtml';

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';

/** The env var the adapter reads; also the name written to the env file. */
export const COOKIE_ENV_NAME = 'CHINADRUGTRIALS_COOKIE';

export const ENV_FILE_NAME = 'cookie.env';

/**
 * Cookie names the site issues for anonymous sessions. If a fetch returns only
 * these, the user has no login-gated entitlement — worth surfacing, because
 * some records are only visible to recognised sessions.
 */
const ANON_COOKIE_PREFIX = 'FSSBBIl';

export interface CookieAcquisitionResult {
  ok: boolean;
  /** The Cookie header value. NEVER log or print this outside an explicit sink. */
  cookie?: string;
  cookieNames?: string[];
  landingStatus?: number;
  validation?: { ok: boolean; status: number; hasResultTable: boolean; challenge: boolean; recordCount?: number };
  reasonCode?: string;
  message?: string;
  fixHint?: string;
}

function parseCookieString(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.includes('=')) continue;
    const index = trimmed.indexOf('=');
    const name = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function serializeCookies(cookies: Record<string, string>): string {
  return Object.entries(cookies)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** Reads `Set-Cookie` pairs from a response, keeping only `name=value`. */
function cookiesFromResponse(response: Response): Record<string, string> {
  const out: Record<string, string> = {};
  // Node exposes multiple Set-Cookie headers through getSetCookie().
  const raw: string[] = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
  for (const header of raw) {
    const first = header.split(';')[0] ?? '';
    const index = first.indexOf('=');
    if (index <= 0) continue;
    const name = first.slice(0, index).trim();
    const value = first.slice(index + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

/** A challenge page has an empty body plus bootstrapping meta tags. */
export function isChallengeHtml(html: string): boolean {
  const stripped = html.replace(/\s+/g, '');
  const lower = html.toLowerCase();
  return (
    (stripped.includes('<body></body>') || stripped.includes('<body/>')) &&
    (lower.split('<meta').length - 1 >= 2 || lower.includes('_$tw') || lower.includes('fssbbi'))
  );
}

function buildSearchForm(keyword: string): Record<string, string> {
  const form: Record<string, string> = {
    keywords: keyword,
    sort: 'desc',
    sort2: '',
    rule: 'CTR',
    secondLevel: '1',
    currentpage: '1',
    id: '',
    ckm_index: '',
  };
  for (const field of [
    'reg_no',
    'indication',
    'case_no',
    'drugs_name',
    'drugs_type',
    'appliers',
    'communities',
    'researchers',
    'agencies',
    'state',
  ]) {
    form[field] = '';
  }
  return form;
}

/**
 * Proves a Cookie actually works by running one real read-only search.
 *
 * Without this, a fetch that returns a stale or insufficient ticket would be
 * reported as success and only fail much later, looking like "no such trial".
 */
async function validateCookie(
  cookie: string,
  keyword: string,
  timeoutMs: number,
): Promise<CookieAcquisitionResult['validation']> {
  const response = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      Origin: 'https://www.chinadrugtrials.org.cn',
      Referer: LANDING_URL,
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: cookie,
    },
    body: new URLSearchParams(buildSearchForm(keyword)).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const html = await response.text();
  const hasResultTable = /searchTable/i.test(html);
  const recordCount = hasResultTable ? (html.match(/<tr[^>]*>/gi) ?? []).length : 0;
  return {
    ok: response.ok && hasResultTable && !isChallengeHtml(html),
    status: response.status,
    hasResultTable,
    challenge: isChallengeHtml(html),
    recordCount,
  };
}

export interface AcquireOptions {
  /** Read-only keyword used to prove the Cookie works. */
  keyword?: string;
  timeoutMs?: number;
}

/**
 * Fetches the site landing page and returns the tickets it issues, validated by
 * one real search. Never throws: every failure comes back as a reasonCode so
 * the CLI can guide the user to the manual path.
 */
export async function acquireCookieFromEntryPage(
  options: AcquireOptions = {},
): Promise<CookieAcquisitionResult> {
  const keyword = options.keyword ?? '胰腺癌';
  const timeoutMs = options.timeoutMs ?? 30_000;

  let landing: Response;
  try {
    landing = await fetch(LANDING_URL, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      ok: false,
      reasonCode: 'ENTRY_PAGE_UNREACHABLE',
      message: `无法访问站点入口页：${(error as Error).message}`,
      fixHint:
        '检查网络连通性；若站点需要代理或正在维护，请改用人工方式：在已能正常访问站点的浏览器中，' +
        '对任一站内请求「复制为 cURL」，再运行 configure --cookie-from-curl。',
    };
  }

  const cookies = cookiesFromResponse(landing);
  if (!Object.keys(cookies).length) {
    return {
      ok: false,
      landingStatus: landing.status,
      reasonCode: 'ENTRY_PAGE_NO_COOKIE',
      message: `站点入口页未下发 Cookie（HTTP ${landing.status}）。`,
      fixHint: '改用人工方式：在浏览器中「复制为 cURL」，再运行 configure --cookie-from-curl。',
    };
  }

  const cookie = serializeCookies(cookies);
  let validation: CookieAcquisitionResult['validation'];
  try {
    validation = await validateCookie(cookie, keyword, timeoutMs);
  } catch (error) {
    return {
      ok: false,
      landingStatus: landing.status,
      reasonCode: 'VALIDATION_REQUEST_FAILED',
      message: `Cookie 校验请求失败：${(error as Error).message}`,
      fixHint: '稍后重试；若持续失败，请改用 configure --cookie-from-curl 提供人工取得的 Cookie。',
    };
  }

  if (!validation?.ok) {
    const detail = validation?.challenge
      ? '站点返回了挑战页'
      : validation?.hasResultTable
        ? '返回了结果表格但未通过校验'
        : `站点未返回结果表格（HTTP ${validation?.status ?? '未知'}）`;
    return {
      ok: false,
      landingStatus: landing.status,
      cookie,
      cookieNames: Object.keys(cookies),
      validation,
      reasonCode: 'ENTRY_PAGE_COOKIE_INSUFFICIENT',
      message: `入口页自动下发的 Cookie 不足以检索：${detail}。`,
      fixHint:
        '该入口页只下发匿名反爬票据。请在已能正常访问站点的浏览器中对该站内请求「复制为 cURL」，' +
        '再运行 configure --cookie-from-curl 粘贴完整命令；本服务不会自动绕过验证码或 WAF。',
    };
  }

  return {
    ok: true,
    cookie,
    cookieNames: Object.keys(cookies),
    landingStatus: landing.status,
    validation,
    message:
      `已从站点入口页取得 ${Object.keys(cookies).length} 个 Cookie 字段（HTTP ${landing.status}），` +
      `并用关键词「${keyword}」实测通过（命中 ${validation.recordCount} 行）。`,
  };
}

/** Extracts a Cookie from a browser "Copy as cURL" command. */
export function extractCookieFromCurl(curlText: string): string | undefined {
  if (!curlText?.trim()) return undefined;
  const patterns = [
    /(?:-b|--cookie)\s+'([^']+)'/s,
    /(?:-b|--cookie)\s+"([^"]+)"/s,
    /(?:-b|--cookie)\s+([^\s\\]+)/,
    /--cookie=([^\s\\]+)/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(curlText);
    if (match?.[1]) {
      const parsed = parseCookieString(match[1]);
      if (Object.keys(parsed).length) return serializeCookies(parsed);
    }
  }
  // Fall back to a raw Cookie header line, which "Copy as cURL" also emits.
  const headerMatch = /-H\s+['"]Cookie:\s*([^'"]+)['"]/i.exec(curlText);
  if (headerMatch?.[1]) {
    const parsed = parseCookieString(headerMatch[1]);
    if (Object.keys(parsed).length) return serializeCookies(parsed);
  }
  return undefined;
}

/** True when the Cookie carries only anonymous anti-bot tickets. */
export function hasOnlyAnonymousTickets(cookie: string): boolean {
  const names = Object.keys(parseCookieString(cookie));
  return names.length > 0 && names.every((name) => name.startsWith(ANON_COOKIE_PREFIX));
}

/**
 * Writes the Cookie to `<configDir>/cookie.env` with mode 0600 and returns the
 * path. It is deliberately NOT written into the JSON config: that file is
 * documented as secret-free, and a Cookie must never travel with it.
 */
export async function writeCookieEnvFile(configDir: string, cookie: string): Promise<string> {
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  const target = path.join(configDir, ENV_FILE_NAME);
  const body =
    `# ChinaDrugTrials 会话 Cookie（由 unified-trial-mcp configure 写入）\n` +
    `# 本文件含凭证，请勿提交版本库、勿分享。权限 0600。\n` +
    `# 用法：set -a; . ${target}; set +a\n` +
    `export ${COOKIE_ENV_NAME}=${shellQuote(cookie)}\n`;
  await fs.writeFile(target, body, { encoding: 'utf8', mode: 0o600 });
  return target;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Masks a Cookie for display: shows only field names and a value fingerprint. */
export function maskCookie(cookie: string): string {
  return Object.entries(parseCookieString(cookie))
    .map(([name, value]) => {
      if (value.length <= 8) return `${name}=****`;
      return `${name}=${value.slice(0, 4)}…${value.slice(-4)}（${value.length} 字符）`;
    })
    .join('; ');
}
