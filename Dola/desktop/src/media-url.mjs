const mediaHosts = ["dola.com", "byteintlapi.com", "ibyteimg.com"];

export function trustedMediaUrl(value) {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port || !mediaHosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`))) throw new Error("素材地址不在允许的 Dola/CDN 域名内");
  // Dola returns HTTP playback URLs; the same signed CDN path supports HTTPS.
  url.protocol = "https:";
  return url.toString();
}

export async function fetchTrustedMedia(fetchMedia, value) {
  let url = trustedMediaUrl(value);
  const seen = new Set();
  while (!seen.has(url)) {
    seen.add(url);
    // Electron's session.fetch Response.url can be empty. Validate each
    // redirect explicitly instead of relying on that field after a fetch.
    const response = await fetchMedia(url, { redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    if (!location) throw new Error("素材下载跳转缺少目标地址");
    url = trustedMediaUrl(new URL(location, url).toString());
  }
  throw new Error("素材下载发生循环跳转");
}
