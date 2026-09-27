import assert from "node:assert/strict";
import test from "node:test";
import { resolveDolaWatermarkUrlRemote } from "./watermark.mjs";

test("uses the Web project's verified no-watermark VOD contract", async () => {
  let requested;
  const source = { fallback_api: "https://vod-urls-mya.byteintlapi.com/video?sig=fixture" };
  const result = await resolveDolaWatermarkUrlRemote(source, { fetchJson: async (url) => {
    requested = new URL(url);
    return { data: { video_info: { data: { video_list: { hd: { main_url: Buffer.from("https://v16-dola.dola.com/no-watermark.mp4").toString("base64"), vwidth: 1920, vheight: 1080 } } } } } };
  } });
  assert.equal(requested.searchParams.get("channel"), "no");
  assert.equal(requested.searchParams.get("codec_type"), "8");
  assert.equal(requested.searchParams.get("logo_type"), "unwatermarked");
  assert.equal(result.downloadUrl, "https://v16-dola.dola.com/no-watermark.mp4");
});
