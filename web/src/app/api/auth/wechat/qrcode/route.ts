import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/auth/session";
import { getAuthSettings } from "@/lib/auth/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 微信扫码登录二维码参数：仅在后台开启微信登录且服务端配置了开放平台凭据时返回 qrconnect 地址。 */
export async function GET() {
    const currentUser = await getCurrentUser();
    if (currentUser) return NextResponse.json({ code: "ALREADY_LOGGED_IN", data: null, msg: "当前已登录" });
    const settings = await getAuthSettings();
    if (!settings.loginMethods.wechat) return NextResponse.json({ code: "WECHAT_DISABLED", data: null, msg: "微信登录未开启" }, { status: 403 });
    const appId = process.env.WECHAT_OPEN_APP_ID?.trim();
    const redirectUri = process.env.WECHAT_OPEN_REDIRECT_URI?.trim();
    if (!appId || !redirectUri) {
        return NextResponse.json({ code: "WECHAT_NOT_CONFIGURED", data: null, msg: "微信登录暂未配置：请在服务端设置 WECHAT_OPEN_APP_ID 与 WECHAT_OPEN_REDIRECT_URI" }, { status: 503 });
    }
    const state = crypto.randomUUID().replace(/-/g, "");
    const qrconnectUrl = `https://open.weixin.qq.com/connect/qrconnect?appid=${encodeURIComponent(appId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=snsapi_login&state=${state}`;
    return NextResponse.json({ code: "OK", data: { qrconnectUrl, state }, msg: "" });
}
