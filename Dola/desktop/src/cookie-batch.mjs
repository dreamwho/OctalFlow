export function cookieImportItems(input) {
  const sources = [...(Array.isArray(input.files) ? input.files : [])];
  if (String(input.text || "").trim()) sources.push({ name: "粘贴内容", text: input.text });
  return sources.flatMap((source) => String(source.text || "").split(/\r?\n/).flatMap((line, index) => line.trim() ? [{ file: String(source.name || "Cookie TXT"), line: index + 1, cookie: line.trim() }] : []));
}
