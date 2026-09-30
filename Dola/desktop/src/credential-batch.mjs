export function credentialImportItems(input) {
  const sources = [...(Array.isArray(input.files) ? input.files : [])];
  if (String(input.text || "").trim()) sources.push({ name: "粘贴内容", text: input.text });
  const seen = new Set();
  return sources.flatMap((source) => String(source.text || "").split(/\r?\n/).flatMap((raw, index) => {
    const value = raw.replace(/^\uFEFF/, "");
    if (!value.trim()) return [];
    const separator = value.search(/[|｜]/);
    const email = value.slice(0, separator).trim();
    const password = value.slice(separator + 1);
    const label = `${source.name || "账号文件"} 第 ${index + 1} 行`;
    if (separator < 1 || /[|｜]/.test(password) || !/^[^\s@|｜]+@[^\s@|｜]+\.[^\s@|｜]+$/.test(email) || !password.trim()) throw new Error(`${label}：请使用 邮箱|密码 格式`);
    const key = email.toLowerCase();
    if (seen.has(key)) throw new Error(`${label}：邮箱重复`);
    seen.add(key);
    return [{ file: String(source.name || "账号文件"), line: index + 1, email, password }];
  }));
}
