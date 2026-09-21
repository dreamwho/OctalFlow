# Dola Camoufox Provider

This is the isolated Dola Web provider used by the `dola` system-channel
protocol. It deliberately keeps the browser session and upstream wire format
outside Next.js. The provider accepts only an internal runtime request from the
web application; it does not expose Dola cookies, proxy credentials, or a
public account-management API.

The production transport is a per-account Camoufox page session. A request is
bound to `accountId`, `credentialVersion`, and the selected proxy egress
snapshot (magic, generic, or chained), then the page
builds the observed Dola Web envelope, captures the SSE acknowledgement and
stores the conversation identity for the result query. `http-session` is
diagnostic-only and is not exposed by the runtime routes. Reference entries
with an already-resolved Dola `uri` are placed into the same attachment block;
raw URL-to-ImageX upload remains a separate capability gate until a live
reference fixture is available.

Set `DOLA_PROVIDER_KEY`, `DOLA_WEB_URL` (normally
`https://www.dola.com/chat/create-image`), and `DOLA_BROWSER_ENGINE=camoufox` in
the internal service environment. `DOLA_CAMOUFOX_BROWSER` may pin an installed
Camoufox browser build for Dola without changing the globally active build used
by GeminiAIStudio. `DOLA_CAMOUFOX_OS` can explicitly select `macos`, `windows`,
or `linux`; otherwise the provider always uses a macOS fingerprint. The provider stores one
real fingerprint preset and stable canvas/audio/font-noise seeds per account in
`DOLA_PROFILE_DIR`, instead of rotating the apparent device on every request.
`DOLA_CAMOUFOX_LOCALE` defaults to `zh-CN`. When a managed proxy is active,
Camoufox GeoIP aligns WebRTC, timezone, and geolocation with that egress. When
the existing GeminiAIStudio-style proxy
manager is enabled, Next.js resolves the selected magic node, generic
node/group, or chained hop/landing egress for each request and passes the
short-lived proxy URL to this provider; it is encrypted in durable task state
and never returned to the web app or written to request logs. No
provider-specific regional proxy environment variable is required.

The Next.js application uses `DREAMYO_DOLA_PROVIDER_URL` and
`DREAMYO_DOLA_PROVIDER_KEY` to reach this internal service. The provider
runtime must have `DOLA_ENABLE_BROWSER=1`; the `DOLA_PROVIDER_KEY` value must
match the application-side key.
Camoufox is imported lazily so contract and SSE tests can run without a
browser binary. Set `DOLA_TASK_ENCRYPTION_KEY` to a deployment secret (the
provider key is only a compatibility fallback) so accepted task identities and
cookies can be recovered after a provider restart. Reference images are fetched
from the signed URL supplied by Next.js, uploaded through Dola's
`prepare_upload` → ImageX Apply/Commit flow, and only the returned Dola URI is
placed in the attachment block; raw URLs are never sent to the page as if they
were uploaded assets.
