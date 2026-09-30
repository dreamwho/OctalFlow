import assert from "node:assert/strict";
import test from "node:test";
import { fetchTrustedMedia, trustedMediaUrl } from "./media-url.mjs";

test("upgrades upstream HTTP media without changing the signed path and query", () => {
  assert.equal(trustedMediaUrl("http://v16-dola.dola.com/video.mp4?sig=a%2Fb&expires=42"), "https://v16-dola.dola.com/video.mp4?sig=a%2Fb&expires=42");
  assert.equal(trustedMediaUrl("https://p16.ibyteimg.com/reference.png"), "https://p16.ibyteimg.com/reference.png");
});

test("rejects unrelated hosts, lookalikes, credentials, ports and non-web URLs", () => {
  for (const url of ["https://dola.com.evil.test/v", "https://evildola.com/v", "https://user:pass@dola.com/v", "https://dola.com:8080/v", "file:///tmp/video.mp4"]) assert.throws(() => trustedMediaUrl(url));
});

test("handles Electron responses with an empty URL and validates every redirect", async () => {
  const seen = [];
  const response = await fetchTrustedMedia(async (url, init) => {
    seen.push(url);
    assert.equal(init.redirect, "manual");
    return seen.length === 1 ? new Response(null, { status: 302, headers: { location: "https://v16-dola.dola.com/final.mp4" } }) : new Response("video", { headers: { "content-type": "video/mp4" } });
  }, "http://vod.byteintlapi.com/video");
  assert.equal(response.url, "");
  assert.equal(await response.text(), "video");
  assert.deepEqual(seen, ["https://vod.byteintlapi.com/video", "https://v16-dola.dola.com/final.mp4"]);
  for (const location of ["https://evil.test/private", "https://vod.byteintlapi.com/video"]) {
    let count = 0;
    await assert.rejects(fetchTrustedMedia(async () => { count++; return new Response(null, { status: 302, headers: { location } }); }, "https://vod.byteintlapi.com/video"));
    assert.equal(count, 1);
  }
});
