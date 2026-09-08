# Octal Canvas internal ChatGPT provider

This is a loopback-only, AGPL-3.0-only transplant of the Python runtime from
ChatGPT2API. It deliberately has no upstream web UI, static-file fallback,
backup/update route, scheduler, or lifecycle watcher.

## Setup and runner

From the repository root, install the locked local environment once:

```sh
cd services/chatgpt-api
sh setup.sh
```

The supervisor runner is:

```sh
services/chatgpt-api/.venv/bin/python services/chatgpt-api/main.py --port "${OCTALAICANVAS_CHATGPT_API_PORT:-8046}"
```

The process always binds `127.0.0.1`; there is no public-host option.

Required environment:

| Variable | Meaning |
| --- | --- |
| `OCTALAICANVAS_CHATGPT_DATA_DIR` | Absolute, dedicated provider data directory. It is created mode 0700. |
| `OCTALAICANVAS_CHATGPT_API_KEY` | Mandatory internal runtime key, at least 32 characters. It is mapped to source `CHATGPT2API_AUTH_KEY`. |
| `OCTALAICANVAS_ENCRYPTION_KEY` | Mandatory AES-256 key: exactly 64 hexadecimal characters or 32-byte Base64. This is the parent application's established secret-key variable. |

Optional:

| Variable | Meaning |
| --- | --- |
| `OCTALAICANVAS_CHATGPT_API_PORT` | Supervisor-provided port; default is 8046. |
| `OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL` | Absolute HTTP(S) base for a root-controlled media proxy, with no embedded username/password. Do not point it at the loopback runtime directly. |

`DATABASE_URL` is intentionally ignored. This provider always uses
`$OCTALAICANVAS_CHATGPT_DATA_DIR/chatgpt2api.db`.

## Required headers

Every request, including unknown paths, `/v1`, and media, requires:

```http
x-octal-runtime-key: <OCTALAICANVAS_CHATGPT_API_KEY>
```

Management calls also use the source master identity:

```http
Authorization: Bearer <OCTALAICANVAS_CHATGPT_API_KEY>
```

External OpenAI-compatible calls retain source semantics and use a source user
API key instead:

```http
Authorization: Bearer <source user API key>
```

The runtime header is an additional transport gate; it does not replace native
source user-key validation.

## Integration routes

`GET /integration/health` needs only the transport header and never returns
credentials:

```json
{"status":"ok","gateway":{"enabled":false},"storage":{"encrypted":true,"backend":"sqlite"}}
```

`GET /integration/gateway` and `PATCH /integration/gateway` need both
headers. The persisted request/response schema is:

```json
{"enabled": true}
```

Gateway defaults to disabled. When disabled, `/v1/*` and media return 503;
management routes remain available.

`GET /integration/auth` needs both the transport header and a native source
user key. It never accepts the master/admin key:

```json
// 200
{"authenticated":true,"role":"user"}
// 401 invalid user key
{"authenticated":false,"role":null}
// 403 master/admin key
{"authenticated":false,"role":"admin"}
```

The `/integration/proxy` mutation surface manages proxy groups, nodes,
defaults and fallbacks; it does not select the active ChatGPT proxy mode.
The Next admin bridge is `/api/admin/chatgpt-api/proxy-selection`, backed by:

```http
GET /integration/proxy-selection
PATCH /integration/proxy-selection
```

The persisted selection shape is:

```json
{"enabled":false,"mode":"native","native_source":"manual","magicConfigured":false,"ipwoConfigured":false}
```

`enabled` is a total switch: `false` forces direct connection and does not
auto-select another source. `mode` has exactly two user-visible values:
`native` (migrated proxy management) and `magic` (Magic Proxy). The
`native_source` field is only the internal native sub-selection, with
`manual` for managed proxy settings or `ipwo` for the IPWO API automatic
source; it is not a third mode. Enabling the policy selects exactly one
`mode`. URL synchronization is separate from changing `mode`, and disabling
Magic Proxy does not restore native automatically.

The PATCH request body contains the three persisted selection fields
`enabled`, `mode` and `native_source`. Both GET and PATCH responses also
include `magicConfigured:boolean` and `ipwoConfigured:boolean`, which are
redacted configuration-state flags rather than credentials. The response is
assembled by `services/proxy_management_service.py` in
`_proxy_selection_payload`.

IPWO has its own management tab/source switch. It selects `native_source`
between `manual` and `ipwo`; it does not implicitly turn on the shared policy
or fall back to another source. The separate IPWO URL source contract is:

```http
GET /integration/ipwo
PATCH /integration/ipwo
POST /integration/ipwo/test
```

`GET /integration/ipwo` returns the redacted shape below. The encrypted
`api_url` is never returned:

The response fields are `configured:boolean`, `has_api_url:boolean`,
`protocol:"http"|"socks5"`, `regions:string` and
`timeout_seconds:number`.

`PATCH /integration/ipwo` accepts `api_url` (optional), `protocol` (`http` or
`socks5`), `regions` and `timeout_seconds`. An omitted or empty `api_url`
preserves the encrypted URL. It changes only source settings; it neither
enables the shared proxy policy nor persists a node. `timeout_seconds` accepts
any positive integer and defaults to `10`; there is no `10`-to-`30` cap.

`POST /integration/ipwo/test` returns `application/x-ndjson` records with
`stage`, `status`, `message`, `elapsed_ms`, optional `done` and optional
`exit_ip`. Stages are `configuration`, `ipwo_api`, `proxy_egress` and
`ipinfo`; the terminal record must have `done:true`. EOF without that record is
a broken stream. This is an explicit temporary diagnostic: it may use saved
configuration while the shared switch is off, but the UI must never invoke it
automatically. It never enables the shared policy or persists a node. Normal
request extraction remains gated by the shared `enabled`/`mode` selection, and
the runtime extractor is not invoked when the total switch is off. Errors are
safe but actionable (for example whitelist, rate-limit, DNS, timeout, numeric
code, success=false, empty-data, JSON and invalid/non-public endpoint cases)
and never expose the URL, query, token, upstream message or exception. Logs
remain redacted; the diagnostic target is fixed at `ipinfo.io/json`, not
supplied by the UI. Each extraction forces `num=1` and `return_type=json`,
regardless of API_LINK input.

Neither shared-policy responses nor IPWO responses echo a proxy URL or proxy
credentials.

Root has added the IPWO UI/API files
`web/src/app/admin/chatgpt-api/components/chatgpt-ipwo-panel.tsx`,
`web/src/services/api/chatgpt-ipwo.ts` and
`web/src/services/api/chatgpt-ipwo.test.ts`; formal Next/Python integration
and user acceptance remain pending. Fake-IP compatibility uses the existing
TUN model, not DoH: only a verified `ipwo.net` HTTPS subdomain on standard
port 443 may resolve to `198.18.0.0/15`; Curl pins that result while keeping
`verify=True`. All other private/reserved DNS is rejected, and returned proxy
IPs must still be public/global. The standalone router
`services/chatgpt-api/api/ipwo.py` still needs to be included from `app.py`,
and shared runtime mode gating remains pending. The backend-focused report is
15/15 and the fake-runtime report is 16/16 only; neither replaces formal
integration. No single test round, including a round reported as `2972`, is
treated as the final full-suite result.

## Source-compatible allowlist

All routes below require the transport header. Routes marked **admin** also
need the source master Authorization header; routes marked **identity** accept
either a valid source user key or the master key.

| Route | Identity | Source schema preserved |
| --- | --- | --- |
| `GET/POST /api/auth/users` | admin | `UserKeyListView`, `UserKeyCreateRequest` / `UserKeyCreateResult` |
| `POST/DELETE /api/auth/users/{key_id}` | admin | `UserKeyUpdateRequest` / `UserKeyUpdateResult`, `UserKeyDeleteResult` |
| `GET/POST/DELETE /api/accounts` | admin | source account list/import/delete schemas |
| `POST /api/accounts/update` | admin | `AccountUpdateRequest` |
| `POST /api/accounts/batch-update` | admin | `AccountBatchUpdateRequest` (status and enable/disable/reset operation) |
| `POST /api/accounts/refresh-access-token` | admin | `AccountOperationRequest` |
| `POST /api/accounts/refresh`, `POST /api/accounts/sync` | admin | `AccountOperationRequest` |
| `GET /api/accounts/operations/{progress_id}` | admin | source progress result |
| `GET /api/accounts/refresh/progress/{progress_id}` | admin | source legacy progress result |
| `GET /api/settings` | admin | source `SettingsView` |
| `PATCH /api/settings` | admin | restricted schema below; source `SettingsMutationResult` |
| `GET /api/model-catalog` | identity | source `ModelCatalogView` |
| `GET /api/logs`, `GET /api/logs/{log_id}` | admin | source `CallSummaryPage`, `CallDetail` |
| `GET /images/{path}`, `GET /image-thumbnails/{path}` | transport only | source media response |
| `GET /v1/models` | identity | source OpenAI response |
| `POST /v1/chat/completions` | identity | source `ChatCompletionRequest` |
| `POST /v1/responses` | identity | source `ResponseCreateRequest` |
| `POST /v1/images/generations` | identity | source `ImageGenerationRequest` |
| `POST /v1/images/edits` | identity | source multipart image-edit parser |

The account request shapes are unchanged source JSON:

```json
// POST /api/accounts
{
  "tokens":["access-token"],
  "accounts":[{"access_token":"access-token","refresh_token":"optional"}],
  "sync_after_import":false,
  "refresh":false,
  "restore":false,
  "return_items":true,
  "target_group_id":null
}
// DELETE /api/accounts and POST refresh/sync operations
{
  "account_ids":["management-id"],
  "access_tokens":["legacy-token"],
  "selection":{
    "mode":"explicit",
    "account_ids":["management-id"],
    "excluded_account_ids":[],
    "keyword":"",
    "status":"all",
    "group_id":"all"
  }
}
// POST /api/accounts/batch-update
{"account_ids":["management-id"],"status":"禁用","operation":"disable"}
// POST /api/accounts/update
{"id":"management-id","type":"plus","quota":0,"proxy":null,"group_id":null}
```

The safe settings patch requires the current source `revision` and accepts
only these optional fields:

```json
{
  "revision":"source-settings-revision",
  "global_system_prompt":"...",
  "sensitive_words":["..."],
  "log_levels":["info"],
  "console_request_timeout_secs":60,
  "image_poll_timeout_secs":60,
  "image_stream_timeout_secs":60,
  "image_poll_initial_wait_secs":5,
  "image_poll_interval_secs":5,
  "image_account_concurrency":1,
  "account_processing_concurrency":1,
  "image_upscale_enabled":false,
  "image_upscale_engine":"pillow_lanczos",
  "image_max_account_attempts":1,
  "image_remove_conversation_after_result":false,
  "image_settle_enabled":true,
  "image_settle_secs":0
}
```

It cannot set proxy runtime, upstream base URL, image storage, GenBox, backup,
third-party apps, retention cleanup, source retry flags, or account
auto-deletion flags.

The OpenAI request schemas remain the vendored source contracts. In particular,
`/v1/images/generations` defaults to
`{"model":"gpt-image-2","n":1,"response_format":"b64_json"}`; image edits
use source-supported multipart fields. Only these OpenAI paths exist:
`/v1/models`, `/v1/chat/completions`, `/v1/responses`,
`/v1/images/generations`, and `/v1/images/edits`.

## Explicitly absent

The wrapper does not mount account detail or token-reveal routes, account
export/import cleanup, account groups, CPA/Sub2API/OAuth routes, source update,
backup, shell/file/static UI routes, proxy administration, cleanup/delete
routes, `/v1/messages`, search, editable files, PPT/PSD, or OpenAPI/docs.
They return 404 after a valid runtime header.

## Media boundary

The root bridge must rewrite JSON and SSE media URLs to its signed application
URLs (or request `b64_json`). It must proxy signed `/images/{path}` and
`/image-thumbnails/{path}` server-side with the runtime header; the bridge
may also send its master Authorization header. Never expose a
`127.0.0.1:8046` URL to a browser. If
`OCTALAICANVAS_CHATGPT_PUBLIC_BASE_URL` is set, it must be a root-controlled
media proxy base, not the raw runtime.

## Persistence and lifecycle guarantees

Account and auth-key payloads are AES-256-GCM encrypted using the compatible
`octalaicanvas-secret:v1:` format. SQLite's account index holds only a
deterministic HMAC derived from the encryption key; access, refresh, and ID
tokens stay in encrypted payload data. System settings and source proxy
configuration are encrypted envelopes too.

No startup account refresh, retry, cleanup, deletion, backup, retention
scheduler, or lifecycle watcher is started. The source account retry and
auto-delete flags are hard-locked false and are not mutable through this
wrapper. Explicit import with `sync_after_import:true`, refresh, sync, and
OpenAI requests can still make upstream calls as their source contracts
require.

## Attribution

See `LICENSE.upstream`, `NOTICE.upstream`, and
`UPSTREAM-SOURCE-MANIFEST.sha256`. The vendored upstream snapshot is
ChatGPT2API 3.2.2, AGPL-3.0-only; the original local source snapshot was not a
Git worktree, so the manifest records file and aggregate SHA-256 checksums
instead of a commit ID.
