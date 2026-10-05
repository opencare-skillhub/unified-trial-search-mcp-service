# Unified Trial Search MCP Service

[![中文](https://img.shields.io/badge/README-中文-red)](./README.zh-CN.md)
[![English](https://img.shields.io/badge/README-English-blue)](./README.md)
[![CI](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml/badge.svg)](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-MIT-green)](#license)
[![Node](https://img.shields.io/badge/node-%E2%89%A522.13-brightgreen)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-8A2BE2)](https://modelcontextprotocol.io/)
[![Tests](https://img.shields.io/badge/tests-46%20passing-success)](#testing)
[![Sources](https://img.shields.io/badge/sources-6%20channels-orange)](#the-six-channels)
[![Tools](https://img.shields.io/badge/MCP%20tools-7-blueviolet)](#the-seven-mcp-tools)

**One MCP endpoint that searches six clinical-trial channels at once — and never lies about what it did not find.**

> 💚 This project exists thanks to **Sam**, contributor to the [小胰宝 (XiaoYiBao) community](https://github.com/xiaoyibao). His care and hard work made it real.

### Documentation map

| What you want to know | Where to look |
|---|---|
| How to deploy to a fresh environment (three commands / one script) | [Install](#install) in this file |
| **Full download URLs, sha256 digests, and the update/publish workflow for all three corpora** | **[docs/corpus-lifecycle.md](docs/corpus-lifecycle.md)** |
| Day-to-day operations, troubleshooting, data-cutoff semantics | [docs/operations.md](docs/operations.md) |
| Design decisions and boundaries (ADRs) | [SPEC.md](SPEC.md) |

![Architecture: one sealed MCP tool surface over six channels, orchestrated with a closed source registry and a per-source terminal state](docs/assets/architecture.svg)

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
| `chictr_pancreatic_archive` | ChiCTR corpus | offline SQLite | 468 pancreatic records + raw HTML, **data cutoff 2026-10-04** |
| `chinadrugtrials` | ChinaDrugTrials | controlled scrape | **contains PI / investigator data** |
| `xyb_chinadrugtrials_archive` | XYB archive | offline package | 139 pancreatic records, structured sections, **data cutoff 2026-09-28** |

Together these cover the global registries, the Chinese registries, and the CDE drug-trial platform —
including the **NMPA/ChinaDrugTrials investigator information** that no other MCP surfaces.

### Getting the offline corpora

Three offline corpora ship as **release assets**, so a cold start does not require hunting for files.
Everything below is public; nothing needs a token, a session or a VPN.

#### The three assets

| Corpus | Download | Size | sha256 (first 16) | Mount flag | Basis |
|---|---|---|---|---|---|
| `chictr_pancreatic` | [chictr_pancreatic.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz) | 25,381,264 B | `abbfc53ba346741b` | `--chictr-corpus` | `upstream_public` |
| `xyb_cde_pancreatic` | [xyb_cde_pancreatic.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz) | 11,032,155 B | `d1ccdac0ef5462a6` | `--xyb-archive` | `community_owned` |
| `ctv_index` | [ctv_index.tar.gz](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz) | 23,964,370 B | `41f07ea5a0b7c1b8` | `--ctv-database` | `community_owned` |

Full URLs, ready to paste into `curl -O`, a mirror script, or an offline download tool:

```
chictr_pancreatic    https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz
xyb_cde_pancreatic   https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz
ctv_index            https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz
```

```bash
# Fetch all three at once, then verify each against the manifest
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/chictr_pancreatic-2026-10-05/chictr_pancreatic.tar.gz
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/xyb_cde_pancreatic-2026-10-05/xyb_cde_pancreatic.tar.gz
curl -LO https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/download/ctv_index-2026-10-05/ctv_index.tar.gz
shasum -a 256 *.tar.gz    # compare one by one with corpora/manifest.json
```

Full digests are in [`corpora/manifest.json`](corpora/manifest.json), which is the contract `fetch-corpus`
enforces. Release pages: [chictr](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/chictr_pancreatic-2026-10-05) ·
[xyb_cde](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/xyb_cde_pancreatic-2026-10-05) ·
[ctv_index](https://github.com/opencare-skillhub/unified-trial-search-mcp-service/releases/tag/ctv_index-2026-10-05).

#### Automatic (recommended)

Checksums are verified, and a failure leaves your existing data byte-identical:

```bash
unified-trial-mcp fetch-corpus --corpus chictr_pancreatic --apply
unified-trial-mcp configure --chictr-corpus ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db

unified-trial-mcp fetch-corpus --corpus xyb_cde_pancreatic --apply
unified-trial-mcp configure --xyb-archive ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic

unified-trial-mcp fetch-corpus --corpus ctv_index --apply
unified-trial-mcp configure --ctv-database ~/.unified-trial-mcp/corpora/ctv_index/ctv.db
```

Drop `--apply` first to see a dry run (URL, byte count, digest, basis) without downloading anything.
`unified-trial-mcp bootstrap` walks the whole cold start interactively and can chain these steps.

#### Manual (mirrors, air-gapped hosts, or if a release is unreachable)

Download the three links above by any means, verify each digest against `corpora/manifest.json`, extract,
then mount the extracted paths:

```bash
# 1. verify (example: chictr)
shasum -a 256 chictr_pancreatic.tar.gz   # must equal the manifest's sha256

# 2. extract — note the resulting layout differs per corpus
tar -xzf chictr_pancreatic.tar.gz -C ~/.unified-trial-mcp/corpora/
tar -xzf xyb_cde_pancreatic.tar.gz -C ~/.unified-trial-mcp/corpora/
tar -xzf ctv_index.tar.gz -C ~/.unified-trial-mcp/corpora/

# 3. mount the extracted paths
unified-trial-mcp configure \
  --chictr-corpus ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db \
  --xyb-archive   ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic \
  --ctv-database  ~/.unified-trial-mcp/corpora/ctv_index/ctv.db

unified-trial-mcp doctor   # every ready source prints OK
```

Or point `fetch-corpus` at your own mirror instead of copying by hand — the digest check still applies:

```bash
unified-trial-mcp fetch-corpus --corpus ctv_index --url https://your-mirror/ctv_index.tar.gz --apply
unified-trial-mcp fetch-corpus --corpus ctv_index --url file:///srv/airgap/ctv_index.tar.gz --apply
```

**Extraction is not uniform**, and getting it wrong fails at query time rather than at install time. Two flags
name a **file** (`--chictr-corpus`, `--ctv-database`), so the payload sits directly under the corpus
directory; `--xyb-archive` names the **parent of packages** — the adapter scans it for subdirectories holding
`summary.json` — so that package keeps one directory level:

```
corpora/chictr_pancreatic/chictr_pancreatic.db   <- file directly inside
corpora/ctv_index/ctv.db                         <- file directly inside
corpora/xyb_cde_pancreatic/胰腺癌/summary.json    <- package stays nested
```

#### Bases for redistribution (why these three are distributable)

Those two bases are deliberately kept distinct (ADR-009 in the spec). Only the first rests on "the data is
public". The other two are the community's own work product: the fact that the upstream CDE site needs a
credentialed session, and that `ctv.veeva.com/robots.txt` forbids crawling `/study-search`, is *irrelevant*
to that basis and must never be used to justify it. Conflating the two would quietly dissolve the rule that
this service never fetches credentialed data for you.

The `ctv_index` corpus carries the index only — **not** the upstream `ctv-mcp-server` code. It still needs its
own checkout (see [Requirements](#requirements)); `fetch-corpus` prints that requirement rather than implying
the source is ready.

Two of those flags name a **file** (`--chictr-corpus`, `--ctv-database`), so the payload lands directly under
the install directory; `--xyb-archive` names the **parent of packages** (the adapter scans it for
subdirectories holding `summary.json`), so that package stays one level down. Each corpus is verified against
the table its own adapter reads (`trials` vs `studies`) — a `.db` that merely opens is not proof of a
working install.

The CTV index has a second half no download can supply: the upstream `ctv-mcp-server` checkout it queries.
`fetch-corpus` prints that requirement rather than pretending the source is ready. Owning the index means a
cold start needs no crawl — but a zero result from it still only ever means "not in this index", never
"this trial does not exist".

Four rules this command follows:

- **sha256 is the contract.** Every byte count and digest comes from `corpora/manifest.json`; a mismatch
  fails the whole operation;
- **A failed download never damages what you have.** The archive is fetched to a temp file, verified,
  extracted to a temp directory, and only then swapped in. Verified by tampering with a single byte: the
  install aborts with a checksum error and the previous corpus is byte-identical afterwards;
- **Nothing credentialed is ever fetched.** You are never handed access you do not have: sessions, controlled
  archives and anything behind a challenge stay manual (ADR-006). Each shipped corpus declares its own basis
  (`upstream_public` or `community_owned`) and an asset without one is refused at install time (ADR-009);
- **Use `--url` for a mirror.** `--url https://…` or `--url file:///…` handles intranets and air-gapped hosts.

The data remains its originators'. ChiCTR's corpus is a public snapshot transported read-only; the Xiaoyibao
CDE archive and CTV index are the community's own work, and registering trials may be revised upstream at any
time, so treat the packaged copies as dated snapshots rather than a source of truth.

**Publishing a new data version?** See [docs/corpus-lifecycle.md](docs/corpus-lifecycle.md) for the full
lifecycle — packaging, uploading a release, the automated deploy path (download → verify → extract → atomic
swap → mount → query), how to publish an updated version every couple of months, troubleshooting, and the
redistribution grounds. It also lists every URL and digest in full.

### Offline snapshots declare their own data cutoff

The two offline sources are **snapshots**, not live data. Each reports its data cutoff explicitly, because a
trial registered after that date is **invisible**, not **absent** — which is the entire reason this project exists:

```jsonc
"freshness": {
  "kind": "offline_archive",
  "dataCutoff": "2026-09-28T07:59:24.275394+08:00",  // nothing in the package is newer
  "cutoffSource": "per-record scrape_time and the summary.json declaration (newer wins); coverage: every record read",
  "updateHint": "...maintained by the Xiaoyibao community; point configure --xyb-archive at a newer package..."
}
```

Three commitments:

- **The cutoff is derived from the data, never hardcoded** — a hardcoded date becomes a lie the moment somebody
  refreshes the data without touching the code;
- **Record-level times outrank the declared summary** — measured on the shipped packages, `summary.json` claims
  `2026-09-29` while the newest of the 139 records is `2026-09-28`, and the earliest reaches back to `2026-08-13`;
  that window is reported rather than smoothed into a single tidy timestamp;
- **`dataCutoff` travels with `search_trials` as well as `get_source_status`** — a zero-result answer has to carry
  where its snapshot stops, or it looks exactly like a zero result from a live registry.

The data is **maintained by the Xiaoyibao community** and depends on people updating it. Run `doctor` to see the
current cutoff at any time.

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

## Reading the status codes

`search_trials` returns one terminal state per source. **Only `SUCCESS` and `NO_RESULTS` mean that source was actually queried**; the other eight all mean no result came back from that channel, and none of them supports any conclusion about whether a trial exists.

| State | How a caller should read it |
|---|---|
| `SUCCESS` | Queried and returned results. Whether they are complete is a separate `completeness` question. |
| `NO_RESULTS` | Queried, and genuinely nothing matched. Read it together with `coverage.zeroResultMeaning`, which says what an empty result means *for that source*. |
| `NOT_ENABLED` | Switched off in this deployment; no request was made. |
| `NEEDS_SETUP` | Missing dependency, path, runtime, or session, so it cannot be queried. `fixHint` gives the fix. |
| `NOT_QUERIED` | No request was ever attempted (usually the overall deadline ran out). Distinct from "tried and failed", so it can be counted separately. |
| `TIMEOUT` | The request went out but did not return in time. The result is unknown. |
| `CHALLENGE_REQUIRED` | The upstream asked for human verification. This service does not bypass captchas or WAFs. |
| `RATE_LIMITED` | Throttled by the upstream. Retrying later may succeed. |
| `DENIED` | Access refused by the source (permissions or an expired session). |
| `FAILED` | Attempted and errored. `reasonCode` and `explanation` say why. |

Every record also carries `attempted`: `false` means no request was made at all. Both `NO_RESULTS` and `TIMEOUT` can look like "nothing found", but only the former means the upstream confirmed an empty result.

**Three channels need particular care when reading them:**

- **CTV is a local index.** A miss means it is not in the local SQLite/FTS store, not that it is absent from ClinicalTrials.gov:
  > 仅表示本地 SQLite/FTS 索引未命中，不代表 ClinicalTrials.gov 上不存在该试验。

- **ICTRP is a lower bound.** It is permanently flagged `isLowerBound: true`; its documented silent gaps mean a small or empty result cannot support "this does not exist":
  > 上游标注结果不完整，估计缺失 N 条；ICTRP 导出存在已知静默缺口，零/少结果不能作为"不存在"的结论。

- **The two offline snapshots declare a data cutoff** (see the next section). A trial registered after that cutoff is invisible in the snapshot, which is not the same as not existing.

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

Requires **Node ≥ 22.13**. No Python required for the offline-corpus path.

The floor is set by `node:sqlite` (the ChiCTR corpus adapter): the module exists from
Node 22.5.0 and stops requiring `--experimental-sqlite` at 22.13.0. On anything older
the service still starts and every other source keeps working — only the ChiCTR corpus
reports `NEEDS_SETUP` (`NODE_SQLITE_UNAVAILABLE`) with the version to upgrade to.

Published on npm, so it can be installed directly:

```bash
npm install -g unified-trial-mcp
unified-trial-mcp doctor        # per-source diagnostics
```

Or build from source:

```bash
git clone https://github.com/opencare-skillhub/unified-trial-search-mcp-service.git
cd unified-trial-search-mcp-service
npm install
npm run build
```

When building from source, `npm run build` sets the executable bit on the
compiled entry. It matters: `tsc` writes 0644, and without that bit the command
installed by `npm install -g` fails with "permission denied" - a failure that
running `node dist/...` locally never reveals.

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

### Deploying to a fresh environment: three commands

After installing the npm package, getting all three offline corpora in place takes three commands:

```bash
npm install -g unified-trial-mcp          # 1) install

unified-trial-mcp bootstrap               # 2) see the plan first (dry-run, touches nothing)
unified-trial-mcp bootstrap --apply       #    then run it

unified-trial-mcp doctor                  # 3) re-check per-source status
```

`bootstrap --apply` **really installs and mounts all three corpora**, running the whole chain in one
go: download → verify byte count → verify sha256 → extract to staging → verify contents → atomic
replace → write the config. Afterwards `doctor` should report:

```
OK   chictr_pancreatic_archive      corpus usable, 468 pancreatic-cancer records.
OK   xyb_chinadrugtrials_archive    1 data package available, keyword: 胰腺癌.
SET  ctv                            CTV database configured, but no upstream MCP service directory.
```

If any step fails it **leaves already-installed data untouched** and is safe to retry; a sha256
mismatch aborts and keeps the previous data.

#### Or one shell script

`scripts/deploy-corpus.sh` wraps the same flow as an idempotent script, for deployment pipelines:

```bash
./scripts/deploy-corpus.sh                     # dry run: prints what it would do
./scripts/deploy-corpus.sh --apply             # execute
./scripts/deploy-corpus.sh --apply --corpus ctv_index        # just one corpus
./scripts/deploy-corpus.sh --apply --mirror https://mirror/  # behind a firewall
```

It adds two things `bootstrap --apply` does not: **a per-corpus dry run** (each prints its URL, byte
count and sha256 before downloading) and **mirror support** (`--mirror` swaps the GitHub prefix, and
also accepts `file://` for a local tarball). Exit code `0` means the script's own deployment steps
succeeded — it deliberately does **not** pass through `doctor`'s exit code, because a fresh machine
has no online sources configured and that would break `&&` chains that actually worked.

#### What still needs a human

`bootstrap` only does what is *mechanically* preparable. It deliberately leaves the following alone;
skipping them does not affect the installed offline corpora — a search reports `NOT_QUERIED` /
`NEEDS_SETUP` rather than pretending to have found nothing.

| Source | What it needs | Command |
|---|---|---|
| ChinaDrugTrials (online) | a session Cookie, once | `configure --cookie-from-entry-page` (automatic) or `configure --cookie-from-curl '<cURL from your browser>'` (manual) |
| ICTRP (online) | an upstream Python service | `configure --ictrp-bundle <ictrp-mcp-service dir>` |
| ChiCTR (online) | an upstream service | `configure --chictr-mcp-server <chictr_trials dir>` |
| CTV (online) | an upstream service | `configure --ctv-mcp-server <ctv-mcp-server dir>`, then `npm install && npm run build` there |

These upstreams are independent third-party / community services with their own runtimes and
dependencies. This service **will not git clone or npm install them for you** — letting a search
service execute upstream code on your machine is a far bigger risk than the few minutes it saves.

`doctor` exit codes: `0` fully ready · `1` degraded but usable · `2` no usable source.

If anything is missing, `doctor` and `bootstrap` print **the exact next command to copy** — never a
bare "not ready".

> Full download URLs, sha256 digests, and the update/publish workflow for all three corpora:
> [docs/corpus-lifecycle.md](docs/corpus-lifecycle.md).

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

### Manual configuration (instead of interactive bootstrap)

If you would rather not run `bootstrap`, or it misdetects something, point `configure` at each asset directly.
Paths must be **absolute** and inside the allowlist; non-ASCII paths need no escaping:

```bash
unified-trial-mcp configure \
  --chictr-corpus   ~/.unified-trial-mcp/corpora/chictr_pancreatic/chictr_pancreatic.db \
  --xyb-archive     ~/.unified-trial-mcp/corpora/xyb_cde_pancreatic \
  --ctv-database    ~/.unified-trial-mcp/corpora/ctv_index/ctv.db \
  --ctv-mcp-server  /path/to/ctv-mcp-server \
  --chictr-mcp-server /path/to/chictr_trials \
  --ictrp-bundle    /path/to/ictrp-mcp-service
```

Configuration lives in `~/.unified-trial-mcp/unified-trial-mcp.config.json` and **never contains a secret**;
the ChinaDrugTrials cookie is kept separately in `cookie.env` (mode 0600) in the same directory. All three
offline corpora are optional: a missing one only makes its own source report `NEEDS_SETUP` with a fix command,
and never blocks the others.

## Safety boundaries

- Does not bypass cookies, access controls, robots, WAF, CAPTCHAs, or other anti-automation measures.
- Does not auto-obtain secrets or controlled data; explicit commands only.
- Never prints a cookie value (only field names and a length fingerprint).
- Secret-key redaction in every log and error path.
- Evidence paths are confined to an allowlist of configured roots.
- Does not convert "not found" into "does not exist" — see "Reading the status codes" above.

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
**Node 22.13 and 24** on **Ubuntu and macOS**: typecheck → build → the suite **three times** (this
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

> **小胰宝社区，依托AI+人文，全心全意为患者/家属服务！**

本项目由 **小胰宝（XiaoYiBao）社区** 贡献者 **Sam** 的 ❤️ 付出促成 —— 感谢他的用心与坚持。

This project was made possible by the ❤️ care and hard work of **Sam**, contributor to the
**小胰宝 (XiaoYiBao) community**. Thank you.

> **小胰宝社区，依托AI+人文，全心全意为患者/家属服务！**
