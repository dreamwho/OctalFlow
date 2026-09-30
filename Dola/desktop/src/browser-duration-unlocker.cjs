(() => {
  const flag = typeof process === "object" && Array.isArray(process.argv) ? process.argv.indexOf("--dola-fingerprint") : -1;
  if (flag !== -1) {
    let fingerprint;
    try { fingerprint = JSON.parse(process.argv[flag + 1]); } catch { fingerprint = null; }
    const define = (target, name, get) => { try { Object.defineProperty(target, name, { get, configurable: true }); } catch (_) {} };
    if (fingerprint && fingerprint.platform) {
      define(Navigator.prototype, "platform", () => fingerprint.platform);
      if (fingerprint.chromeVersion) {
        const fullVersion = fingerprint.fullVersion || `${fingerprint.chromeVersion}.0.0.0`;
        const brands = [{ brand: "Not-A.Brand", version: "24" }, { brand: "Chromium", version: fingerprint.chromeVersion }, { brand: "Google Chrome", version: fingerprint.chromeVersion }];
        const fullVersionList = [{ brand: "Not-A.Brand", version: "24.0.0.0" }, { brand: "Chromium", version: fullVersion }, { brand: "Google Chrome", version: fullVersion }];
        const userAgentData = {
          brands, mobile: false, platform: fingerprint.uaPlatform,
          getHighEntropyValues: async (hints = []) => {
            const values = { brands, mobile: false, platform: fingerprint.uaPlatform };
            const map = { architecture: "x86", bitness: "64", fullVersionList, model: "", platformVersion: fingerprint.platformVersion, uaFullVersion: fullVersion, wow64: false };
            for (const hint of hints) if (Object.prototype.hasOwnProperty.call(map, hint)) values[hint] = map[hint];
            return values;
          },
          toJSON: () => ({ brands, mobile: false, platform: fingerprint.uaPlatform }),
        };
        define(Navigator.prototype, "userAgentData", () => userAgentData);
      }
    }
    if (fingerprint) {
      if (Number.isFinite(fingerprint.hardwareConcurrency)) define(Navigator.prototype, "hardwareConcurrency", () => fingerprint.hardwareConcurrency);
      if (Number.isFinite(fingerprint.deviceMemory)) define(Navigator.prototype, "deviceMemory", () => fingerprint.deviceMemory);
      if (Array.isArray(fingerprint.navigatorLanguages)) {
        define(Navigator.prototype, "languages", () => fingerprint.navigatorLanguages.slice());
        define(Navigator.prototype, "language", () => fingerprint.navigatorLanguages[0]);
      }
      // 确定性噪声：同一账号每次访问得到完全相同的扰动，噪声本身不成为新指纹。
      const hashNoise = (seedValue, index) => {
        let h = (seedValue ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
        h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
        h ^= h >>> 16;
        return (h >>> 0) / 4294967296;
      };
      const sparseNoise = (seedValue, size, count, apply) => {
        if (!Number.isFinite(seedValue) || size <= 0) return;
        for (let k = 0; k < count; k++) {
          const position = Math.floor(hashNoise(seedValue, k) * size);
          apply(position, hashNoise(seedValue, k + 0x9e37));
        }
      };
      if (fingerprint.timezone && fingerprint.timezone.timeZone) {
        const timeZone = fingerprint.timezone.timeZone;
        // Intl 按调用日期解析真实偏移（含夏令时），按小时桶缓存避免高频调用开销。
        const offsetCache = new Map();
        Date.prototype.getTimezoneOffset = function () {
          const bucket = Math.floor(this.getTime() / 3600000);
          const cacheKey = `${bucket}`;
          if (offsetCache.has(cacheKey)) return offsetCache.get(cacheKey);
          let offset = 0;
          try {
            const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" }).formatToParts(this).find((part) => part.type === "timeZoneName")?.value || "GMT";
            if (/^GMT[+-]\d\d:\d\d$/.test(name)) {
              const [hours, minutes] = name.slice(3).split(":");
              const sign = name[3] === "-" ? -1 : 1;
              offset = -(sign * (Number(hours) * 60 + Number(minutes)));
            }
          } catch (_) {}
          if (offsetCache.size > 512) offsetCache.clear();
          offsetCache.set(cacheKey, offset);
          return offset;
        };
        const resolved = Intl.DateTimeFormat.prototype.resolvedOptions;
        Intl.DateTimeFormat.prototype.resolvedOptions = function () { const options = resolved.call(this); options.timeZone = timeZone; return options; };
      }
      if (fingerprint.screen && Number.isFinite(fingerprint.screen.width)) {
        for (const [name, value] of [["width", fingerprint.screen.width], ["height", fingerprint.screen.height], ["availWidth", fingerprint.screen.width], ["availHeight", fingerprint.screen.availHeight], ["colorDepth", 24], ["pixelDepth", 24]]) define(Object.getPrototypeOf(screen), name, () => value);
        if (Number.isFinite(fingerprint.screen.devicePixelRatio)) define(window, "devicePixelRatio", () => fingerprint.screen.devicePixelRatio);
      }
      if (Number.isFinite(fingerprint.canvasSeed)) {
        const canvasSeed = fingerprint.canvasSeed;
        // 1/255 透明度的确定性像素点：视觉不可辨，但足以改变画布哈希。
        const drawNoise = (canvas, context) => {
          const positions = Math.min(8, canvas.width * canvas.height);
          for (let k = 0; k < positions; k++) {
            const x = Math.floor(hashNoise(canvasSeed, k * 2) * canvas.width);
            const y = Math.floor(hashNoise(canvasSeed, k * 2 + 1) * canvas.height);
            if (x < canvas.width && y < canvas.height) { context.fillStyle = `rgba(${Math.floor(hashNoise(canvasSeed, k) * 255)},${Math.floor(hashNoise(canvasSeed, k + 99) * 255)},${Math.floor(hashNoise(canvasSeed, k + 199) * 255)},0.004)`; context.fillRect(x, y, 1, 1); }
          }
        };
        const getImageDataOriginal = CanvasRenderingContext2D.prototype.getImageData;
        CanvasRenderingContext2D.prototype.getImageData = function (...args) {
          const image = getImageDataOriginal.apply(this, args);
          sparseNoise(canvasSeed, image.data.length, 64, (position, random) => { image.data[position] = (image.data[position] + (random > 0.5 ? 1 : -1) + 256) % 256; });
          return image;
        };
        const toDataURLOriginal = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function (...args) {
          const context = this.getContext("2d");
          if (context) drawNoise(this, context);
          return toDataURLOriginal.apply(this, args);
        };
        const toBlobOriginal = HTMLCanvasElement.prototype.toBlob;
        HTMLCanvasElement.prototype.toBlob = function (...args) {
          const context = this.getContext("2d");
          if (context) drawNoise(this, context);
          return toBlobOriginal.apply(this, args);
        };
        if (typeof OffscreenCanvas !== "undefined" && OffscreenCanvas.prototype.convertToBlob) {
          const convertOriginal = OffscreenCanvas.prototype.convertToBlob;
          OffscreenCanvas.prototype.convertToBlob = function (...args) {
            const context = this.getContext("2d");
            if (context) drawNoise(this, context);
            return convertOriginal.apply(this, args);
          };
        }
        for (const prototype of [typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null, typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null]) {
          if (!prototype || !prototype.readPixels) continue;
          const readPixelsOriginal = prototype.readPixels;
          prototype.readPixels = function (...args) {
            readPixelsOriginal.apply(this, args);
            const pixels = args[6];
            if (pixels && pixels.length) sparseNoise(canvasSeed, pixels.length, 32, (position, random) => { pixels[position] = (pixels[position] + (random > 0.5 ? 1 : -1) + 256) % 256; });
          };
        }
      }
      if (Number.isFinite(fingerprint.audioSeed)) {
        const audioSeed = fingerprint.audioSeed;
        // 幅度 1e-7 量级的扰动听不见，但足以改变 AudioContext 指纹；同一缓冲区只扰动一次。
        const noisyBuffers = new WeakSet();
        const getChannelDataOriginal = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function (...args) {
          const channel = getChannelDataOriginal.apply(this, args);
          if (!noisyBuffers.has(channel)) {
            noisyBuffers.add(channel);
            sparseNoise(audioSeed, channel.length, 64, (position, random) => { channel[position] += (random - 0.5) * 1e-7; });
          }
          return channel;
        };
        for (const name of ["getFloatFrequencyData", "getFloatTimeDomainData"]) {
          const original = typeof AnalyserNode !== "undefined" ? AnalyserNode.prototype[name] : null;
          if (!original) continue;
          AnalyserNode.prototype[name] = function (array) {
            original.call(this, array);
            sparseNoise(audioSeed, array.length, 16, (position, random) => { array[position] += (random - 0.5) * 1e-7; });
          };
        }
      }
      if (fingerprint.webgl && fingerprint.webgl.renderer) {
        const unmaskedVendor = 0x9245;
        const unmaskedRenderer = 0x9246;
        for (const prototype of [typeof WebGLRenderingContext !== "undefined" ? WebGLRenderingContext.prototype : null, typeof WebGL2RenderingContext !== "undefined" ? WebGL2RenderingContext.prototype : null]) {
          if (!prototype) continue;
          const getParameterOriginal = prototype.getParameter;
          prototype.getParameter = function (parameter) {
            if (parameter === unmaskedVendor) return fingerprint.webgl.vendor;
            if (parameter === unmaskedRenderer) return fingerprint.webgl.renderer;
            return getParameterOriginal.call(this, parameter);
          };
        }
      }
      if (Number.isFinite(fingerprint.voicesSeed) && typeof speechSynthesis !== "undefined" && speechSynthesis.getVoices) {
        const voicesSeed = fingerprint.voicesSeed;
        const getVoicesOriginal = speechSynthesis.getVoices.bind(speechSynthesis);
        speechSynthesis.getVoices = () => {
          const voices = getVoicesOriginal();
          // 按种子稳定洗牌，列表内容与真实系统一致但顺序每账号不同。
          const shuffled = [...voices];
          for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(hashNoise(voicesSeed, i) * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
          }
          return shuffled;
        };
      }
      if (fingerprint.battery && typeof Navigator.prototype.getBattery === "function") {
        const battery = fingerprint.battery;
        Navigator.prototype.getBattery = () => Promise.resolve({
          get charging() { return battery.charging; },
          get level() { return battery.level; },
          get chargingTime() { return battery.chargingTime; },
          get dischargingTime() { return battery.dischargingTime; },
          addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
          onchargingchange: null, onlevelchange: null, onchargingtimechange: null, ondischargingtimechange: null,
        });
      }
      if (fingerprint.doNotTrack === null || fingerprint.doNotTrack === "1") define(Navigator.prototype, "doNotTrack", () => fingerprint.doNotTrack);
    }
  }
  const ipcRenderer = typeof require === "function" ? require("electron").ipcRenderer : { send() {} };
  if (["www.dola.com", "accounts.google.com"].includes(location.hostname)) {
    let observer;
    let scheduled = false;
    const report = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; ipcRenderer.send("dola:registration-dom"); });
    };
    ipcRenderer.on?.("dola:registration-observe", (_event, enabled) => {
      observer?.disconnect();
      observer = undefined;
      if (!enabled) return;
      const start = () => {
        observer = new MutationObserver(report);
        observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "aria-hidden"] });
        report();
      };
      if (document.documentElement) start();
      else document.addEventListener("DOMContentLoaded", start, { once: true });
    });
  }
  if (!/(^|\.)dola\.com$/i.test(location.hostname) || window.__DOLA_STUDIO_DURATION_OPTIONS__) return;
  window.__DOLA_STUDIO_DURATION_OPTIONS__ = true;
  const reportSubmit = (input, body) => {
    try {
      const url = new URL(typeof input === "string" ? input : input?.url || "", location.href);
      if (url.hostname === "www.dola.com" && url.pathname === "/chat/completion" && typeof body === "string") {
        const key = crypto.randomUUID();
        ipcRenderer.send("dola:browser-submit", { key, url: url.toString(), body });
        return key;
      }
    } catch {}
    return "";
  };
  const extractConversationId = (text) => String(text || "").replace(/\\"/g, '"').match(/"(?:conversation_id|conversationId)"\s*:\s*"?(\d{12,32})/)?.[1] || "";
  const observeResponse = (key, response) => {
    if (!key) return;
    if (!response.ok || !response.body) { ipcRenderer.send("dola:browser-submit-end", key); return; }
    const reader = response.clone().body.getReader();
    const decoder = new TextDecoder();
    void (async () => {
      let tail = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) return;
          const combined = tail + decoder.decode(value, { stream: true });
          const conversationId = extractConversationId(combined);
          if (conversationId) { ipcRenderer.send("dola:browser-submit-ack", { key, conversationId }); void reader.cancel(); return; }
          tail = combined.slice(-512);
        }
      } catch {} finally { reader.releaseLock(); ipcRenderer.send("dola:browser-submit-end", key); }
    })();
  };

  const configUrl = (input) => /(?:skill\/pack|action_bar_v3\/get_item_conf|get_item_conf|slot\/action_bar|samantha\/creation)/.test(typeof input === "string" ? input : input?.url || "");
  const addDurations = (value, seen = new Set()) => {
    if (!value || typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    let changed = false;
    if (Array.isArray(value)) { for (const item of value) changed = addDurations(item, seen) || changed; return changed; }
    const label = String(value.label || value.name || value.title || value.show_name || "").toLowerCase();
    for (const key of ["option_list", "options"]) {
      const options = value[key];
      if (!Array.isArray(options)) continue;
      const isDuration = label.includes("时长") || label.includes("duration") || options.some((item) => /^(?:5|10)s$/i.test(String(item?.display_text || item?.show_name || "")));
      if (!isDuration) continue;
      for (const duration of ["15", "30"]) {
        if (options.some((item) => String(item?.option_key || item?.value) === duration)) continue;
        const sample = options.find((item) => String(item?.option_key || item?.value) === "10") || options[0] || {};
        options.push({ ...sample, id: Math.max(0, ...options.map((item) => Number(item?.id) || 0)) + 1, option_key: duration, value: duration, display_text: `${duration}s`, show_name: `${duration}s`, is_default: false });
        changed = true;
      }
    }
    if (Array.isArray(value.supported_durations)) {
      for (const duration of [15, 30]) if (!value.supported_durations.some((item) => Number(item) === duration)) { value.supported_durations.push(duration); changed = true; }
    }
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === "string" && /^[\[{]/.test(child.trim())) {
        try { const parsed = JSON.parse(child); if (addDurations(parsed, seen)) { value[key] = JSON.stringify(parsed); changed = true; } } catch {}
      } else changed = addDurations(child, seen) || changed;
    }
    return changed;
  };
  const patchText = (text) => {
    try { const data = JSON.parse(text); return addDurations(data) ? JSON.stringify(data) : text; }
    catch { return text; }
  };

  const fetchOriginal = window.fetch;
  window.fetch = async function (...args) {
    let submitBody = args[1]?.body;
    if (typeof submitBody !== "string" && typeof Request !== "undefined" && args[0] instanceof Request && new URL(args[0].url).pathname === "/chat/completion") submitBody = await args[0].clone().text();
    const key = reportSubmit(args[0], submitBody);
    let response;
    try { response = await fetchOriginal.apply(this, args); }
    catch (error) { if (key) ipcRenderer.send("dola:browser-submit-end", key); throw error; }
    observeResponse(key, response);
    if (!configUrl(args[0])) return response;
    const original = await response.clone().text();
    const patched = patchText(original);
    return patched === original ? response : new Response(patched, { status: response.status, statusText: response.statusText, headers: response.headers });
  };

  const openOriginal = XMLHttpRequest.prototype.open;
  const sendOriginal = XMLHttpRequest.prototype.send;
  const urls = new WeakMap();
  XMLHttpRequest.prototype.open = function (...args) { urls.set(this, args[1]); return openOriginal.apply(this, args); };
  XMLHttpRequest.prototype.send = function (...args) {
    const key = reportSubmit(urls.get(this), args[0]);
    if (key) this.addEventListener("loadend", () => {
      if (this.status < 200 || this.status >= 300 || (this.responseType && this.responseType !== "text")) return;
      const conversationId = extractConversationId(this.responseText);
      if (conversationId) ipcRenderer.send("dola:browser-submit-ack", { key, conversationId });
      ipcRenderer.send("dola:browser-submit-end", key);
    }, { once: true });
    if (configUrl(urls.get(this))) this.addEventListener("readystatechange", () => {
      if (this.readyState !== 4 || this.status !== 200 || (this.responseType && this.responseType !== "text")) return;
      try {
        const patched = patchText(this.responseText);
        if (patched !== this.responseText) {
          Object.defineProperty(this, "responseText", { configurable: true, value: patched });
          Object.defineProperty(this, "response", { configurable: true, value: patched });
        }
      } catch {}
    });
    return sendOriginal.apply(this, args);
  };
})();
