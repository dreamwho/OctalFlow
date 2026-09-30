export function isAllowedLoginUrl(value) {
  try {
    const { protocol, hostname } = new URL(value);
    const host = hostname.toLowerCase();
    const domain = (name) => host === name || host.endsWith(`.${name}`);
    return protocol === "https:" && (domain("dola.com") || domain("google.com") || domain("apple.com") || domain("facebook.com") || host === "sg-link.byteoversea.com");
  } catch { return false; }
}
