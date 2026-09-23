# macOS 正式签名与 Apple 公证

Dreamyo 的 DMG 和 ZIP 面向站外直接分发，正式包必须用 Apple Developer Program 中的 **Developer ID Application** 证书签名，并通过 Apple 公证。仅有本地自签名/开发签名不能替代它。项目构建会拒绝误用本地证书；`DREAMYO_DESKTOP_UNSIGNED_TEST=1` 仅用于本机验收，产物不得分发。

## 一次性配置

1. 使用 Apple Developer Program 团队创建并安装 **Developer ID Application** 证书，保留其私钥在本机登录钥匙串。验证：`security find-identity -v -p codesigning` 应列出完整的 `Developer ID Application: ... (TEAMID)` 身份。不要使用 Apple Development、Mac App Store 或本地开发证书。
2. 为 Apple 公证配置 App Store Connect API Key，或将 Apple ID 的 App 专用密码通过 `xcrun notarytool store-credentials Dreamyo-Notary --apple-id <AppleID> --team-id <TEAMID>` 写入钥匙串；该命令会交互式提示密码。不要将 `.p8` 私钥、App 专用密码、P12 或其密码提交到 Git。
3. 设置当前终端的 `DREAMYO_MAC_SIGN_IDENTITY` 为上述 Developer ID 身份，并设置 `APPLE_KEYCHAIN_PROFILE=Dreamyo-Notary`。如凭据存于非默认钥匙串，再设置 `APPLE_KEYCHAIN`。也可按 electron-builder 26 的约定通过 `CSC_NAME` 和完整的一组 `APPLE_API_KEY` / `APPLE_API_KEY_ID` / `APPLE_API_ISSUER` 或 `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` 配置。

## 每次发布

在 macOS 上先完成应用所需的生产构建，再执行 `pnpm pack:admin:mac` 或 `pnpm pack:commercial:mac`。构建流程会检查证书身份、公证凭据和 `notarytool`，electron-builder 对 app 签名、启用 Hardened Runtime、提交公证并装订票据。管理员版和商用版分别产出 DMG/ZIP。

交付前逐个检查 DMG 内的 `.app`：

```sh
codesign --verify --deep --strict --verbose=2 "/Applications/Dreamyo 管理员本地版.app"
spctl --assess --verbose --type exec "/Applications/Dreamyo 管理员本地版.app"
xcrun stapler validate "/Applications/Dreamyo 管理员本地版.app"
hdiutil verify "apps/desktop/dist/admin/Dreamyo-admin-mac-arm64-0.1.0.dmg"
```

签名配置与凭据门禁由 `apps/desktop/scripts/macos-release.test.mjs` 覆盖。每次发布仍需在未安装开发者证书的干净 Mac 上安装并首次启动验收。
