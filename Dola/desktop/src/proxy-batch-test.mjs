export async function testProxyNodes(nodes, test, onProgress, isCancelled = () => false) {
  const summary = { completed: 0, total: nodes.length, connected: 0, failed: 0, cancelled: false };
  for (const item of nodes) {
    if (isCancelled()) { summary.cancelled = true; break; }
    onProgress({ type: "testing", item, ...summary });
    let result;
    try { result = await test(item); }
    catch (error) { result = { connected: false, error: String(error?.message || error) }; }
    summary.completed += 1;
    summary[result?.connected ? "connected" : "failed"] += 1;
    onProgress({ type: "result", item, result, ...summary });
  }
  summary.cancelled ||= summary.completed < summary.total && isCancelled();
  return summary;
}
