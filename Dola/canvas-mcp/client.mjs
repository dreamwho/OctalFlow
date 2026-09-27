export function canvasApiClient(options = {}) {
  const root = String(options.baseUrl || process.env.DREAMYO_CANVAS_API_BASE_URL || "").replace(/\/+$/, "");
  const key = String(options.key || process.env.DREAMYO_CANVAS_API_KEY || "");
  const url = new URL(root);
  if (!["http:", "https:"].includes(url.protocol) || !key) throw new Error("请配置 DREAMYO_CANVAS_API_BASE_URL 和 DREAMYO_CANVAS_API_KEY");
  async function request(method, params, body) {
    const target = new URL("/api/external/canvas", url);
    for (const [name, value] of Object.entries(params || {})) if (value) target.searchParams.set(name, String(value));
    const response = await fetch(target, { method, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const payload = await response.json();
    if (!response.ok || payload.code !== 0) throw new Error(payload.msg || `HTTP ${response.status}`);
    return payload.data;
  }
  return {
    createCanvas: (input) => request("POST", {}, input),
    getRun: (runId) => request("GET", { runId }),
    getProject: (projectId) => request("GET", { projectId }),
  };
}
