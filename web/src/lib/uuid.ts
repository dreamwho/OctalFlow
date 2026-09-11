/** crypto.randomUUID 只在安全上下文（HTTPS/localhost）暴露，局域网 HTTP 访问时回退到 getRandomValues。 */
export function safeRandomUUID(): string {
    const cryptoApi = globalThis.crypto as Crypto | undefined;
    if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues === "function") {
        const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
        return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
}
