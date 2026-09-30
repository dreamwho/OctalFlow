export function registrationStepDelay() {
  return 50 + Math.floor(Math.random() * 1451);
}

export function registrationAction(page) {
  if (page.blank) return { type: "reload", message: "页面尚未加载完成，正在自动重新加载…" };
  if (page.origin === "https://www.dola.com") {
    if (page.pageUnavailable) return { type: "click-reload", message: "Dola 页面暂时不可用，正在自动重试…" };
    if (page.ageConfirm) return { type: "click-age", message: "正在确认 Dola 年龄提示…" };
    if (page.googleLogin) return { type: "click-google", message: "正在点击 Google 登录…" };
    if (page.login) return { type: "click-login", message: "正在打开 Dola 登录…" };
    return { type: "wait", message: "正在等待 Dola 登录态验证…" };
  }
  if (page.origin === "https://accounts.google.com") {
    if (page.insecureBrowser) return { type: "error", message: "Google 认为当前浏览器环境不安全，已停止自动登录；请关闭随机 User-Agent 后重试" };
    if (page.deleted) return { type: "error", message: "Google 提示此账号已被删除" };
    if (page.invalidAccount) return { type: "error", message: "Google 提示找不到此账号" };
    if (page.invalidPassword) return { type: "error", message: "Google 提示密码不正确" };
    if (page.serverError) return { type: "error", message: "Google 返回 500 服务器错误；请稍后重新打开该账号" };
    if (page.challenge) return { type: "approval", message: "Google 要求额外验证，请在浏览器中完成" };
    if (page.notice) return { type: "click-notice", message: "正在继续 Google 账号告知…" };
    if (page.allow && page.oauthForDola) return { type: "click-allow", message: "正在确认 Google 授权…" };
    if (page.allow) return { type: "approval", message: "Google 授权目标未确认为 Dola，请检查当前页面" };
    if (page.password) return { type: "password", message: "正在填写 Google 密码…" };
    if (page.email) return { type: "email", message: "正在填写 Google 邮箱…" };
    return { type: "wait", message: "正在等待 Google 登录页面…" };
  }
  return { type: "approval", message: "登录跳转到了未识别的页面，请在浏览器中检查" };
}

export function registrationTargetScript(origin, selector, labels = [], scroll = false) {
  return `(() => {
    if (location.origin !== ${JSON.stringify(origin)}) return null;
    const items = [...document.querySelectorAll(${JSON.stringify(selector)})];
    const target = items.find((item) => {
      const rect = item.getBoundingClientRect(), style = getComputedStyle(item);
      return !item.disabled && rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && (!${JSON.stringify(labels)}.length || ${JSON.stringify(labels)}.includes((item.innerText || item.getAttribute('aria-label') || '').trim()));
    });
    if (!target) return null;
    if (${scroll}) target.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    const rect = target.getBoundingClientRect();
    const x = Math.round(rect.left + rect.width / 2), y = Math.round(rect.top + rect.height / 2);
    return rect.width && rect.height ? { x, y, width: innerWidth, height: innerHeight } : null;
  })()`;
}
