export function completionRequestShape(request) {
  let ability = {};
  try { ability = JSON.parse(request.chat_ability?.ability_param || "{}"); } catch {}
  const parameters = ability.ability_param || ability;
  return {
    clientMetaKeys: Object.keys(request.client_meta || {}).sort(),
    localConversationIdLength: String(request.client_meta?.local_conversation_id || "").length,
    optionKeys: Object.keys(request.option || {}).sort(),
    optionValues: Object.fromEntries(["need_create_conversation", "support_lazy_fetch_stream", "message_from", "scene_type"].filter((key) => request.option?.[key] !== undefined).map((key) => [key, request.option[key]])),
    abilityType: request.chat_ability?.ability_type,
    abilityKeys: Object.keys(parameters || {}).sort(),
    messageBlockTypes: (request.messages || []).flatMap((item) => item.content_block || []).map((block) => block.block_type),
    extKeys: Object.keys(request.ext || {}).sort(),
    hasFingerprint: Boolean(request.ext?.fp),
    hasCollectionId: Boolean(request.option?.collect_id),
  };
}

export function parseManualSubmit(url, body) {
  let request;
  let endpoint;
  try { request = JSON.parse(body); endpoint = new URL(url); } catch { return null; }
  if (endpoint.hostname !== "www.dola.com" || endpoint.pathname !== "/chat/completion" || request?.option?.need_create_conversation !== true) return null;
  let ability;
  try { ability = JSON.parse(request.chat_ability?.ability_param || "{}"); } catch { return null; }
  const modelWire = String(ability.model || ability.ability_param?.model || "");
  const model = { "seedance_v2.5": "dola-seedance-2-5", "seedance_v2.0": "dola-seedance-2-0-fast", "Seedream 4.5": "dola-seedream-4-5" }[modelWire];
  if (!model) return null;
  const parameters = ability.ability_param || ability;
  const blocks = (request.messages || []).flatMap((item) => item.content_block || []);
  const prompt = String(parameters.input_box_content?.user_input_content || blocks.map((block) => block.content?.text_block?.text || "").filter(Boolean).at(-1) || "").trim();
  const references = blocks.flatMap((block) => block.content?.attachment_block?.attachments || []).map((item) => ({ name: String(item.image?.name || "参考图"), role: "reference", url: String(item.image?.image_ori?.url || item.image?.url || "") }));
  const identity = Object.fromEntries(["device_id", "web_id", "tea_uuid", "region", "sys_region", "web_tab_id"].map((key) => [key, endpoint.searchParams.get(key) || ""]));
  return { model, prompt, duration: Number(parameters.duration || 0), ratio: String(parameters.ratio || "16:9"), references, identity, requestShape: completionRequestShape(request) };
}
