export async function restoreTaskDraft(task, readAsset, assets = []) {
  if (!task || !["completed", "failed"].includes(task.status)) throw new Error("请选择已完成或失败的任务");
  if (!task.prompt?.trim()) throw new Error("任务缺少原始提示词，请先打开原会话查询状态");
  const references = [];
  for (const reference of task.references || []) {
    if (task.source === "browser" && !reference.id) throw new Error(`浏览器任务的参考素材“${reference.name || "未命名"}”没有可用原图，无法安全再次生成`);
    const matches = reference.id ? [] : assets.filter((asset) => asset.mime?.startsWith("image/") && asset.name === reference.name);
    const id = reference.id || (matches.length === 1 ? matches[0].id : "");
    if (!id) throw new Error(`参考素材“${reference.name || "未命名"}”${matches.length > 1 ? "存在同名文件" : "已丢失"}，无法安全恢复原参考图`);
    references.push({ ...await readAsset(id), role: reference.role });
  }
  return { model: task.model, prompt: task.prompt, duration: task.duration || 5, ratio: task.ratio || "16:9", references };
}
