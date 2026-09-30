export const fingerprintOptions = [
  // Google 登录会拒绝与客户端提示不一致的 User-Agent，默认不随机 UA，仅在用户明确勾选时启用。
  { key: "userAgent", label: "User-Agent 版本", default: false },
  { key: "languages", label: "语言" },
  { key: "timezone", label: "时区" },
  { key: "hardwareConcurrency", label: "CPU 核心数" },
  { key: "deviceMemory", label: "设备内存" },
  { key: "screen", label: "屏幕与像素比" },
  { key: "canvasAudio", label: "Canvas/音频噪声" },
  { key: "webgl", label: "WebGL 显卡" },
  { key: "voices", label: "语音列表" },
  { key: "battery", label: "电池状态" },
  { key: "doNotTrack", label: "Do Not Track" },
];

export const defaultFingerprintParams = () => fingerprintOptions.filter((item) => item.default !== false).map((item) => item.key);

// 选项键与指纹字段的对应：合并补齐时以字段是否已存在判断，避免同名选项重复随机。
const optionField = { userAgent: "userAgent", languages: "languages", timezone: "timezone", hardwareConcurrency: "hardwareConcurrency", deviceMemory: "deviceMemory", screen: "screen", canvasAudio: "canvasSeed", webgl: "webgl", voices: "voicesSeed", battery: "battery", doNotTrack: "doNotTrack" };

// Google 登录会拦截平台或大版本与真实引擎不一致的 User-Agent，因此只在真实平台和
// Chromium 大版本内随机小版本号，保证 UA 与 Sec-CH-UA 客户端提示保持一致。
const runtime = typeof process === "undefined" ? {} : process;
const chromeMajor = String(runtime.versions?.chrome || "").split(".")[0] || "146";
const windows = runtime.platform === "win32";
const linux = runtime.platform === "linux";
export const fingerprintEnvironment = {
  chromeMajor,
  osToken: windows ? "Windows NT 10.0; Win64; x64" : linux ? "X11; Linux x86_64" : "Macintosh; Intel Mac OS X 10_15_7",
  platform: windows ? "Win32" : linux ? "Linux x86_64" : "MacIntel",
  uaPlatform: windows ? "Windows" : linux ? "Linux" : "macOS",
  platformVersion: windows ? "15.0.0" : linux ? "6.5.0" : "10.15.7",
};

// Electron 默认 UA 会带应用名与 Electron token，直接暴露自动化客户端；
// 基础 UA 统一换成与当前引擎完全一致的干净 Chrome 身份（大版本取真实值）。
export const baseUserAgent = () => `Mozilla/5.0 (${fingerprintEnvironment.osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`;

const userAgentProfiles = ["0.7204.169", "0.7284.183", "0.7355.0", "0.7168.61"].map((build) => ({
  userAgent: `Mozilla/5.0 (${fingerprintEnvironment.osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.${build} Safari/537.36`,
  platform: fingerprintEnvironment.platform,
  uaPlatform: fingerprintEnvironment.uaPlatform,
  platformVersion: fingerprintEnvironment.platformVersion,
  chromeVersion: chromeMajor,
  fullVersion: `${chromeMajor}.${build}`,
}));

const languageProfiles = [
  { languages: "en-US,en;q=0.9", navigatorLanguages: ["en-US", "en"] },
  { languages: "en-GB,en;q=0.9", navigatorLanguages: ["en-GB", "en"] },
  { languages: "zh-CN,zh;q=0.9,en;q=0.8", navigatorLanguages: ["zh-CN", "zh", "en"] },
];

// 偏移量由 preload 端用 Intl 按真实日期动态计算，天然覆盖夏令时，无需 DST 表。
const timezoneProfiles = [
  { timeZone: "Asia/Tokyo" },
  { timeZone: "Asia/Shanghai" },
  { timeZone: "Asia/Hong_Kong" },
  { timeZone: "Asia/Singapore" },
  { timeZone: "Europe/London" },
  { timeZone: "Europe/Berlin" },
  { timeZone: "America/Chicago" },
  { timeZone: "America/Denver" },
  { timeZone: "America/Los_Angeles" },
  { timeZone: "Australia/Sydney" },
];

// devicePixelRatio 与分辨率档位成对出现，避免 4K 屏配 dpr 2、笔电低分屏配 dpr 1 的矛盾组合。
const screenProfiles = [
  { width: 1920, height: 1080, availHeight: 1040, devicePixelRatio: 1 },
  { width: 2560, height: 1440, availHeight: 1400, devicePixelRatio: 1 },
  { width: 1366, height: 768, availHeight: 728, devicePixelRatio: 1 },
  { width: 1440, height: 900, availHeight: 860, devicePixelRatio: 2 },
  { width: 1536, height: 864, availHeight: 824, devicePixelRatio: 1.25 },
  { width: 1680, height: 1050, availHeight: 1010, devicePixelRatio: 2 },
];

// WebGL 只在真实平台内随机：macOS 恒为 Apple GPU，Windows/Linux 用 ANGLE 字符串，
// 避免 UA 平台与显卡平台互相矛盾。
const webglProfiles = windows
  ? [
      { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
      { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 4060 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
      { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Intel(R) UHD Graphics 630 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
      { vendor: "Google Inc. (AMD)", renderer: "ANGLE (AMD, AMD Radeon RX 6600 Direct3D11 vs_5_0 ps_5_0, D3D11)" },
    ]
  : linux
    ? [
        { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (CML GT2), OpenGL 4.6)" },
        { vendor: "Google Inc. (Intel)", renderer: "ANGLE (Intel, Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2), OpenGL 4.6)" },
      ]
    : [
        { vendor: "Apple", renderer: "Apple M1" },
        { vendor: "Apple", renderer: "Apple M2" },
        { vendor: "Apple", renderer: "Apple M3" },
        { vendor: "Apple", renderer: "Apple M4" },
      ];

const batteryProfiles = [
  { charging: true, level: 1, chargingTime: 0, dischargingTime: Infinity },
  { charging: false, level: 0.85, chargingTime: Infinity, dischargingTime: 12600 },
  { charging: false, level: 0.55, chargingTime: Infinity, dischargingTime: 7200 },
  { charging: false, level: 0.3, chargingTime: Infinity, dischargingTime: 3900 },
];

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const seed = () => 1 + Math.floor(Math.random() * 2147483646);

export function randomFingerprint(enabled = fingerprintOptions.map((item) => item.key)) {
  const fingerprint = {};
  if (enabled.includes("userAgent")) Object.assign(fingerprint, pick(userAgentProfiles));
  if (enabled.includes("languages")) Object.assign(fingerprint, pick(languageProfiles));
  if (enabled.includes("timezone")) fingerprint.timezone = pick(timezoneProfiles);
  if (enabled.includes("hardwareConcurrency")) fingerprint.hardwareConcurrency = pick([4, 6, 8, 12, 16, 20]);
  if (enabled.includes("deviceMemory")) fingerprint.deviceMemory = pick([4, 8, 16]);
  if (enabled.includes("screen")) fingerprint.screen = pick(screenProfiles);
  if (enabled.includes("canvasAudio")) { fingerprint.canvasSeed = seed(); fingerprint.audioSeed = seed(); }
  if (enabled.includes("webgl")) fingerprint.webgl = pick(webglProfiles);
  if (enabled.includes("voices")) fingerprint.voicesSeed = seed();
  if (enabled.includes("battery")) fingerprint.battery = pick(batteryProfiles);
  // 大多数真实浏览器未设置 DNT（null），仅少量返回 "1"。
  if (enabled.includes("doNotTrack")) fingerprint.doNotTrack = Math.random() < 0.8 ? null : "1";
  return fingerprint;
}

// 旧账号指纹缺新参数时只补缺失项，不改动已持久化的取值，保证同一账号身份稳定。
export function mergeMissingFingerprint(existing) {
  const merged = { ...(existing || {}) };
  for (const key of defaultFingerprintParams()) {
    if (optionField[key] in merged) continue;
    Object.assign(merged, randomFingerprint([key]));
  }
  if (merged.screen && !Number.isFinite(merged.screen.devicePixelRatio)) {
    const ratio = merged.screen.width === 1440 || merged.screen.width === 1680 ? 2 : merged.screen.width === 1536 ? 1.25 : 1;
    merged.screen = { ...merged.screen, devicePixelRatio: ratio };
  }
  return merged;
}
