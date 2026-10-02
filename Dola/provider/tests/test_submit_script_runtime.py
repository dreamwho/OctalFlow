"""Functional test for MAIN_WORLD_SUBMIT_SCRIPT under a mocked page runtime.

The over-15s rule-prime flow is orchestration-heavy (send rule body, wait for the
conversation ACK, patch the content body, resend), so the script is executed for
real inside node with a mocked DOM/XHR instead of only asserting on its source.
"""

import json
import shutil
import subprocess
import tempfile
from pathlib import Path

import pytest

from dola_api.page_scripts import MAIN_WORLD_SUBMIT_SCRIPT

HARNESS = r"""
const fs = require("fs");
const vm = require("vm");
const scriptSource = fs.readFileSync(process.argv[2], "utf8");
const scenario = process.argv[3];
const ruleReply = 'event: SSE_ACK\ndata: {"conversation_id":"38418048283899153"}\n\nevent: SSE_REPLY_END\ndata: {}\n\n';
const contentReply = 'event: SSE_REPLY_END\ndata: {"ok":true}\n\n';
const sent = [];
let xhrSeq = 0;
class MockXHR {
  constructor() { this.readyState = 0; this.status = 0; this.responseText = ""; this.responseURL = ""; this._headers = {}; this.onreadystatechange = null; this.onerror = null; }
  open(method, url) { this._url = url; }
  setRequestHeader(key, value) { this._headers[key] = value; }
  getResponseHeader(key) { return this._headers[String(key).toLowerCase()] || null; }
  send(body) {
    const seq = ++xhrSeq;
    sent.push({ seq, url: this._url, body });
    const reply = scenario === "prime" && seq === 1 ? ruleReply : contentReply;
    Promise.resolve().then(() => {
      this.readyState = 4;
      this.status = 200;
      this.responseText = reply;
      this.responseURL = this._url + "&a_bogus=fixture";
      if (this.onreadystatechange) this.onreadystatechange();
    });
  }
}
const resultEl = { id: "__dola_submit_result__", value: "", style: {}, remove() {} };
const resourceUrl = "https://www.dola.com/samantha/skill/pack?device_id=111222333444555666&web_id=111222333444555666&tea_uuid=111222333444555666&web_tab_id=tab-fixture&fp=verify_fixture&aid=3658";
const sandbox = {
  window: { bdms: {}, __DOLA_SUBMIT_CONFIG__: JSON.parse(fs.readFileSync(process.argv[4], "utf8")) },
  document: {
    title: "fixture",
    getElementById: () => resultEl,
    createElement: () => resultEl,
    documentElement: { appendChild: () => {} },
  },
  location: { origin: "https://www.dola.com", href: "https://www.dola.com/chat/123", hostname: "www.dola.com" },
  performance: { getEntriesByType: () => [{ name: resourceUrl }] },
  XMLHttpRequest: MockXHR,
  URL,
  URLSearchParams,
  setTimeout,
  clearTimeout,
  console,
};
vm.createContext(sandbox);
vm.runInContext(scriptSource, sandbox);
const deadline = Date.now() + 5000;
const wait = () => {
  if (resultEl.value || Date.now() > deadline) {
    fs.writeFileSync(process.argv[5], JSON.stringify({ result: JSON.parse(resultEl.value || "null"), sent }, null, 2));
    process.exit(0);
  }
  setTimeout(wait, 50);
};
wait();
"""


def _run_script(scenario: str, config: dict) -> dict:
    node = shutil.which("node")
    if not node:
        pytest.skip("node runtime unavailable")
    with tempfile.TemporaryDirectory() as tmp:
        base = Path(tmp)
        (base / "script.js").write_text(MAIN_WORLD_SUBMIT_SCRIPT, encoding="utf-8")
        (base / "config.json").write_text(json.dumps(config), encoding="utf-8")
        (base / "harness.js").write_text(HARNESS, encoding="utf-8")
        out = base / "out.json"
        subprocess.run([node, str(base / "harness.js"), str(base / "script.js"), scenario, str(base / "config.json"), str(out)], check=True, timeout=30)
        return json.loads(out.read_text(encoding="utf-8"))


def _config(rule_body: dict | None) -> dict:
    content = {
        "client_meta": {"local_conversation_id": "local_1234567890123456", "conversation_id": "", "bot_id": "747"},
        "messages": [{"content_block": [{"block_type": 10000, "content": {"text_block": {"text": "生成视频：海边日落，9:16"}}}]}],
        "option": {"need_create_conversation": True, "conversation_init_option": {"need_ack_conversation": True}, "unique_key": "u1"},
        "chat_ability": {"ability_type": 17, "ability_param": json.dumps({"model": "seedance_v2.5", "duration": 30, "ratio": "9:16"})},
    }
    rule = {
        "client_meta": {"local_conversation_id": "local_1234567890123456", "conversation_id": "", "bot_id": "747"},
        "messages": [{"content_block": [{"block_type": 10000, "content": {"text_block": {"text": "## 30 秒视频生成规则"}}}]}],
        "option": {"need_create_conversation": True, "conversation_init_option": {"need_ack_conversation": True}, "unique_key": "u0"},
        "chat_ability": {"ability_type": 17, "ability_param": json.dumps({"model": "seedance_v2.5", "duration": 30, "ratio": "9:16"})},
    }
    return {
        "body": json.dumps(content, ensure_ascii=False),
        **({"ruleBody": json.dumps(rule, ensure_ascii=False)} if rule_body else {}),
        "fallbackQuery": "",
        "timeoutMs": 60000,
        "hookDeadline": 9999999999999,
    }


def test_submit_script_primes_rule_message_then_patched_content_body():
    outcome = _run_script("prime", _config({"prime": True}))
    assert outcome["result"] and not outcome["result"].get("fatal")
    assert [item["seq"] for item in outcome["sent"]] == [1, 2]
    first = json.loads(outcome["sent"][0]["body"])
    second = json.loads(outcome["sent"][1]["body"])
    assert "## 30 秒视频生成规则" in first["messages"][0]["content_block"][0]["content"]["text_block"]["text"]
    assert first["option"]["need_create_conversation"] is True
    assert second["client_meta"]["conversation_id"] == "38418048283899153"
    assert second["option"]["need_create_conversation"] is False
    assert "conversation_init_option" not in second["option"]
    assert "海边日落" in second["messages"][0]["content_block"][0]["content"]["text_block"]["text"]
    assert outcome["result"]["ruleConversationId"] == "38418048283899153"
    assert outcome["result"]["status"] == 200
    assert outcome["result"]["signed"] is True


def test_submit_script_without_rule_body_sends_exactly_once():
    outcome = _run_script("single", _config(None))
    assert outcome["result"] and not outcome["result"].get("fatal")
    assert len(outcome["sent"]) == 1
    body = json.loads(outcome["sent"][0]["body"])
    assert body["option"]["need_create_conversation"] is True
    assert body["client_meta"]["conversation_id"] == ""
    assert "ruleConversationId" not in outcome["result"]
