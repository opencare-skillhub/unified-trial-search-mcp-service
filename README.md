# Unified Trial Search MCP Service

[![中文](https://img.shields.io/badge/README-中文-red)](./README.zh-CN.md)
[![English](https://img.shields.io/badge/README-English-blue)](./README.md)
[![CI](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml/badge.svg)](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-46%20passing-success)](#testing)
[![Sources](https://img.shields.io/badge/sources-6%20channels-orange)](#the-six-channels)
[![Tools](https://img.shields.io/badge/MCP%20tools-7-blueviolet)](#the-seven-mcp-tools)

**One MCP endpoint that searches six clinical-trial channels at once — and never lies about what it did not find.**

> 💚 This project exists thanks to **Sam**, contributor to the [小胰宝 (XiaoYiBao) community](https://github.com/xiaoyibao). His care and hard work made it real.

![Architecture: one sealed MCP tool surface over six channels, orchestrated with a closed source registry and an honesty contract](docs/assets/architecture.svg)

`doctor` tells you the truth about every channel — and never prints a cookie:

![Terminal output of unified-trial-mcp doctor showing six sources ready and exit code 0](docs/assets/doctor.png)

---

## Why this exists

Anyone who has searched for clinical trials knows the drill: five browser tabs, four different
registry search boxes, three different identifier formats, and no way to tell whether "0 results"
meant *the trial does not exist* or *the index just doesn't cover it*.

Existing trial MCP servers solve this one registry at a time. That is exactly the wrong shape for
the question people actually ask — *"is there a trial for my patient, anywhere?"* — because the
answer is only meaningful if you can prove you looked everywhere and say honestly where you could not.

**This service is the union of six channels behind a single sealed tool surface**, built around one
uncompromising rule:

> **Never silently convert "I could not look" into "it is not there."**

That single rule turns out to drive almost every design decision below.

## Why it is different

| | Typical single-registry MCP | **This service** |
|---|---|---|
| Channels | 1 | **6** (online + offline corpora) |
| Cross-source dedup | ✗ | ✅ merges only on **confirmed registration identity** |
| "0 results" | returned bare | ✅ **never** alone — carries the source's own coverage caveat |
| Failure reporting | generic error | ✅ **10 terminal states**, each machine-readable |
| Partial coverage | invisible | ✅ `coverage` + `completeness` + truncation flags |
| Caller-supplied URLs / timeouts | common | ✅ **impossible by construction** (closed registry) |
| Secrets in config | often | ✅ separate `cookie.env`, mode 0600, never printed |
| New-environment setup | manual, 5 services | ✅ **one registration** + `doctor` + guided `bootstrap` |

## The six channels

| Source ID | Channel | Kind | What it is good at |
|---|---|---|---|
| `ictrp` | WHO ICTRP | online aggregator | global breadth; multi-registry by design |
| `ctv` | Veeva CTV | online + local FTS | CT.gov depth, fast local index |
| `chictr_online` | ChiCTR | online | Chinese registered trials, live |
| `chictr_pancreatic_archive` | ChiCTR corpus | offline SQLite | 468 pancreatic records + raw HTML |
| `chinadrugtrials` | ChinaDrugTrials | controlled scrape | **contains PI / investigator data** |
| `xyb_chinadrugtrials_archive` | XYB archive | offline package | 139 pancreatic records, structured sections |

Together these cover the global registries, the Chinese registries, and the CDE drug-trial platform —
including the **NMPA/ChinaDrugTrials investigator information** that no other MCP surfaces.

### Cross-source identity that actually holds up

Searches fan out, then results are merged — but **only when registration identity is confirmed**:

```
ctv:UTN000552084  ┐
                  ├─►  NCT:NCT07066098   (one trial, two views)
ictrp:NCT07066098 ┘
```

Two records with *identical titles* but *different registry numbers* are **never** merged. Verified
against real data: 15 raw hits → 13 canonical records, with the 2 merges manually checked. Every
merged record keeps `mergedFrom`, `sourceLabels` and `perSource`, so the merge is always auditable.

## The honesty contract

Ten terminal states. Only two of them mean "we actually looked":

| State | Means |
|---|---|
| `SUCCESS` | queried, results returned |
| `NO_RESULTS` | queried, genuinely nothing — **and carries the source's caveat** |
| `NOT_ENABLED` | source switched off |
| `NEEDS_SETUP` | missing dependency, path, runtime, or session |
| `NOT_QUERIED` | never attempted (deadline ran out) |
| `TIMEOUT` | started, did not finish in time |
| `CHALLENGE_REQUIRED` | human verification needed — **never bypassed** |
| `RATE_LIMITED` | upstream throttling |
| `DENIED` | access refused by the source |
| `FAILED` | attempted and errored |

`NO_RESULTS` is never returned bare. A local-index miss says so:

> *"仅表示本地 SQLite/FTS 索引未命中，不代表 ClinicalTrials.gov 上不存在该试验。"*

...and ICTRP — which has documented silent gaps — is permanently flagged `isLowerBound: true`:

> *"上游标注结果不完整，估计缺失 N 条；ICTRP 导出存在已知静默缺口，零/少结果不能作为'不存在'的结论。"*

## The seven MCP tools

**Query (read-only — never refreshes, never mutates an index):**

| Tool | Required | Purpose |
|---|---|---|
| `search_trials` | ≥1 of `keyword`/`keywords`/`condition`/`terms` | bounded-concurrency fan-out; per-source terminal states, coverage, completeness |
| `get_trial_detail` | `recordId` | one record; `recordId` is `<sourceId>:<sourceRecordId>` |
| `get_record_evidence` | `recordId` | raw evidence: `raw_html`/`source_json`/`source_word`/`raw_text`/`field_excerpt` |
| `get_source_status` | — | per-source readiness, freshness, diagnostics |

**Maintenance (explicit only, dry-run by default):**

| Tool | Purpose |
|---|---|
| `refresh_ictrp` | refresh ICTRP cache/snapshots |
| `sync_ctv_index` | rebuild the CTV local index |
| `sync_chinadrugtrials` | incrementally archive ChinaDrugTrials |

### The closed registry guarantee

`search_trials` accepts **only registered source IDs**. No tool accepts a URL, an upstream tool name,
a custom timeout, a filesystem path, a cookie, or a secret. Callers cannot redirect this service at
an arbitrary endpoint — enforced by schema and covered by tests that scan every tool's properties for
forbidden names (`url`/`path`/`timeout`/`cookie`/`token`/`secret`/`credential`/`command`/`tool`).

## Install

Requires **Node ≥ 20**. No Python required for the offline-corpus path.

```bash
git clone https://github.com/opencare-skillhub/unified-trial-search-mcp-service.git
cd unified-trial-search-mcp-service
npm install
npm run build
```

### Register with your MCP client

```json
{
  "mcpServers": {
    "unified-trial-mcp": {
      "command": "node",
      "args": ["/absolute/path/unified-trial-search-mcp-service/dist/src/cli/main.js", "serve"],
      "env": { "UNIFIED_TRIAL_CONFIG_DIR": "/absolute/path/.unified-trial-mcp" }
    }
  }
}
```

**One registration. That is the whole integration.** The service talks to the other channels itself.

### Five-minute setup

```bash
# 1) Diagnose: per-source runtime, dependencies, data paths, freshness, session
node dist/src/cli/main.js doctor

# 2) Mount local assets (writes <configDir>/unified-trial-mcp.config.json, mode 0600)
node dist/src/cli/main.js configure \
  --chictr-corpus     /absolute/path/chictr_pancreatic.db \
  --xyb-archive       /absolute/path/xyb-chinadrugtrials-data/output \
  --ictrp-bundle      /absolute/path/ictrp-mcp-service \
  --ctv-mcp-server    /absolute/path/ctv-mcp-server \
  --chictr-mcp-server /absolute/path/chictr_trials

# 3) Explicit bootstrap (dry-run by default, prints a plan)
node dist/src/cli/main.js bootstrap
node dist/src/cli/main.js bootstrap --apply

# 4) Acquire the ChinaDrugTrials session (automatic; guides you if it fails)
node dist/src/cli/main.js configure --cookie-from-entry-page

# 5) Re-check
node dist/src/cli/main.js doctor
```

`doctor` exit codes: `0` fully ready · `1` degraded but usable · `2` no usable source.

If anything is missing, `doctor` and `bootstrap` print **the exact next command to copy** — never a
bare "not ready".

## Configuration

| Priority | Mechanism |
|---|---|
| 1 (highest) | CLI flags |
| 2 | environment variables |
| 3 | config file |
| 4 | defaults |

Two files in the config directory, deliberately separated:

| File | Contents | Mode |
|---|---|---|
| `unified-trial-mcp.config.json` | paths only — **never secrets**, safe to copy or commit | `0600` |
| `cookie.env` | session cookie, written by `configure` | `0600` |

Real environment variables **override** `cookie.env`, so an explicit `export` always wins. A missing
`cookie.env` means "not configured" — never a fabricated credential.

### About the ChinaDrugTrials session

New environments can acquire it without touching a browser:

```bash
unified-trial-mcp configure --cookie-from-entry-page
```

This performs **one ordinary GET of the site's public landing page**, receives the two anonymous
anti-bot tickets the site hands out (`FSSBBIl1UgzbN7N80S` / `...T`), then **proves them with a real
read-only search** before saving. If the site needs a logged-in session, the manual fallback is:

```bash
unified-trial-mcp configure --cookie-from-curl '<browser "Copy as cURL" command>'
```

**This is not a WAF bypass, and the distinction is load-bearing.** The site *gives* us those tickets
for a normal visit: no CAPTCHA is solved, no challenge is defeated, no rate limit is evaded, no
credential is forged. That is categorically different from defeating an access control — which this
service never does. `doctor` and `bootstrap` **never** acquire a cookie themselves; they only print
the command and explain what failed. The service never reads another project's config file or a
browser profile.

## Safety boundaries

- Does not bypass cookies, access controls, robots, WAF, CAPTCHAs, or other anti-automation measures.
- Does not auto-obtain secrets or controlled data; explicit commands only.
- Never prints a cookie value (only field names and a length fingerprint).
- Secret-key redaction in every log and error path.
- Evidence paths are confined to an allowlist of configured roots.
- Does not convert "not found" into "does not exist" — see the honesty contract above.

## Project layout

```
src/
  core/         types, registry, config, orchestrator, merger, normalizer, logger, MCP transport
  adapters/     one per channel: ictrp, ctv, chictr-online, chictr-pancreatic,
                chinadrugtrials, xyb-archive
  tools/        7 MCP tools: schemas, handlers, server
  cli/          single entry: serve / doctor / bootstrap / configure; cookie acquisition
test/           46 tests: unit, adapters, orchestrator, tools
scripts/        CI guards (closed-registry invariant)
docs/           operations manual, test reports, diagram assets
.github/        CI workflow: typecheck, build, 3 test runs, invariant guards
```

## Testing

```bash
npm test
```

```
# tests 46
# pass 46
# fail 0
```

One test is opt-in because it needs a real ChiCTR corpus (a snapshot CI does not ship). Without it
the suite reports `45 pass / 1 skip`; run it against your own copy with:

```bash
UNIFIED_TRIAL_TEST_CHICTR_CORPUS=/path/to/chictr_pancreatic.db npm test
```

Coverage includes: record identity and normalization, merge-only-on-confirmed-identity, adapter
contracts against real data, the 4-concurrency / 75-second deadline orchestrator (including the
distinction between "never started" and "timed out"), all 7 tool schemas and error contracts, cookie
acquisition and masking, and challenge-page detection.

### Continuous integration

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every push and pull request across
**Node 20 and 22** on **Ubuntu and macOS**: typecheck → build → the suite **three times** (this
project has deadline- and concurrency-sensitive paths, so one green run is weak evidence) → CLI smoke
test → two invariant guards:

- **No committed secrets** — fails if `cookie.env` or a config file is ever tracked.
- **Closed registry** — [`scripts/check-closed-registry.mjs`](scripts/check-closed-registry.mjs)
  re-checks the built schemas from outside the test process, failing the build if any tool property
  would let a caller name an endpoint, path, timeout, or credential.

Verified end-to-end against live sources: `search_trials` across all six channels, cross-source
merges, detail and evidence retrieval, maintenance dry-runs, and the full new-environment cookie flow
with **zero environment variables**.

## Known data caveats

Documented rather than hidden — see [`docs/operations.md`](./docs/operations.md):

- XYB archive `summary.json` `scrape_time` conflicts with individual records.
- ChinaDrugTrials flattened `details` is unreliable (`申请人名称 = "12"`); nested `sections` is authoritative.
- 31 historic ChiCTR records have `registration_number = NULL` — `project_id` is the real identity.
- ICTRP has documented silent gaps, so a low count never proves absence.

## License

MIT. See [LICENSE](./LICENSE).

> ⚠️ Public source material may contain personal information. Returned data reflects its source;
> respect each registry's terms of use and applicable law, and do not treat public accessibility as
> unrestricted redistribution. Never commit `cookie.env`.

---

## 致谢 / Acknowledgements

本项目由 **小胰宝（XiaoYiBao）社区** 贡献者 **Sam** 的 ❤️ 付出促成 —— 感谢他的用心与坚持。

This project was made possible by the ❤️ care and hard work of **Sam**, contributor to the
**小胰宝 (XiaoYiBao) community**. Thank you.
