# GeminiAI provider sidecar

This service is the isolated GeminiAI provider for OctalFlow. It is derived
from `chrysoljq/aistudio-api`; see [NOTICE.md](NOTICE.md) and
[LICENSE.upstream](LICENSE.upstream) for retained MIT attribution.

Compose starts it as the internal `geminiai` service. The OctalFlow app uses
`OCTALAICANVAS_GEMINIAI_URL` and `OCTALAICANVAS_GEMINIAI_API_KEY`; the latter is
also passed to the sidecar as `AISTUDIO_API_KEY`. Do not expose port 8080 on a
public host or put this credential in browser code.

The public `GET /health` endpoint is only for container health checks. Account
and generation routes require `Authorization: Bearer <key>` or `X-API-Key`:

- `/accounts`, `/accounts/active`, login start/status, import, activate, update
  and delete
- `/rotation`, `/rotation/mode`, and `/rotation/accounts`
- `/v1/models`, `/v1/chat/completions`, `/v1/images/generations`, and
  `/v1/images/edits`
- `/v1beta/models/{model}:generateContent` and `:streamGenerateContent`

Google account state is persisted only in the `octalaicanvas-geminiai-accounts`
volume at `/data/accounts`. The container starts as root only long enough to
make that private volume owner-only, then drops to the `geminiai` user. New
account directories use `0700`; account metadata, registry, and auth files use
`0600`. Raw request/response dumping remains disabled by default. The image
downloads both Camoufox and fallback CloakBrowser binaries during its build,
so a running container does not need a first-use browser download.

For a repository-local production start (`pnpm build && pnpm start`), the web
supervisor starts this provider on `127.0.0.1:18080` and persists accounts under
`web/.data/geminiai/accounts`. An explicitly configured
`OCTALAICANVAS_GEMINIAI_URL` plus `OCTALAICANVAS_GEMINIAI_API_KEY` continues to
take precedence, so Compose and remote-provider deployments are unchanged.

The imported provider supports text, image generation/editing, and Google
Search through the documented routes above. It does **not** expose a verified
video-generation or asynchronous video-status API, so GeminiAI must not be
advertised as providing that capability until an upstream contract is added and
tested.

The default browser is Camoufox, matching both migrated reference projects;
`AISTUDIO_BROWSER=chromium` remains an explicit fallback. Browser authorization
state is engine-specific: accounts previously authorized in Chromium must be
authorized once in the Provider's Camoufox window before Camoufox can use them.
The two declared image models are `gemini-3-pro-image` and
`gemini-3.1-flash-image`. `AISTUDIO_API_KEY` protects this local sidecar and is
not a Google upstream credential.

`POST /accounts/login/start` accepts `{ "name"?: string, "headless"?: boolean,
"ui_locale"?: string }`. A Google authorization requires a browser-capable
runtime and an interactive human login; a host browser's existing session is
not automatically shared with this isolated container. In a Linux container
without `DISPLAY` or `WAYLAND_DISPLAY`, a headed (`headless: false`) request is
rejected with an actionable login-status error instead of claiming that a host
browser window was opened.
