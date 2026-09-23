export function macSigningOptions(env = process.env) {
    if (env.DREAMYO_DESKTOP_UNSIGNED_TEST === "1") {
        return { identity: null, hardenedRuntime: false, notarize: false };
    }

    return {
        identity: env.DREAMYO_MAC_SIGN_IDENTITY?.trim() || env.CSC_NAME?.trim(),
        hardenedRuntime: true,
        entitlements: "resources/entitlements.mac.plist",
        entitlementsInherit: "resources/entitlements.mac.plist",
        notarize: true,
    };
}

export function validateMacReleaseEnvironment({ env = process.env, identities = "" } = {}) {
    if (env.DREAMYO_DESKTOP_UNSIGNED_TEST === "1") return null;

    const identity = (env.DREAMYO_MAC_SIGN_IDENTITY || env.CSC_NAME || "").trim();
    if (!identity.startsWith("Developer ID Application:")) {
        throw new Error("macOS 正式包需要显式配置 Developer ID Application 证书身份；本地测试包请设置 DREAMYO_DESKTOP_UNSIGNED_TEST=1");
    }
    if (!env.CSC_LINK && !identities.includes(`\"${identity}\"`)) {
        throw new Error(`找不到有效的签名身份：${identity}。请先将 Developer ID Application 证书安装到登录钥匙串，或配置 CSC_LINK。`);
    }

    const appleIdAuth = env.APPLE_ID && env.APPLE_APP_SPECIFIC_PASSWORD && env.APPLE_TEAM_ID;
    const apiKeyAuth = env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER;
    const keychainAuth = env.APPLE_KEYCHAIN_PROFILE;
    if (!appleIdAuth && !apiKeyAuth && !keychainAuth) {
        throw new Error("缺少 Apple 公证凭据：请在本机钥匙串保存 notarytool profile，或配置完整的 App Store Connect API Key / Apple ID 凭据。不要把密钥写入仓库。");
    }

    return identity;
}
