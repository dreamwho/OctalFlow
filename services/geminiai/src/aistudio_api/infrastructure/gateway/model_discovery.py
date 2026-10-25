"""Read the account's native model picker without submitting generation requests."""

from __future__ import annotations

import re
import time

from aistudio_api.config import settings

_MODEL_ID = re.compile(r"(?:models/)?(?:gemini|gemma)-[A-Za-z0-9_.-]+\Z")
_UNSUPPORTED = re.compile(r"(?:^|[-_.])(omni|veo|audio|tts|speech|voice|music|sound|lyria|live)(?:$|[-_.])", re.I)


def read_model_picker(page) -> list[dict]:
    timeout = settings.timeout_capture * 1000
    page.locator("ms-model-selector button.model-selector-card").click(timeout=timeout)
    dialog = page.get_by_role("dialog").last
    dialog.wait_for(state="visible", timeout=timeout)
    models: dict[str, dict] = {}
    for tab, capability in (("Gemini", "text"), ("Gemma", "text"), ("Images", "image")):
        dialog.get_by_role("button", name=tab, exact=True).click(timeout=timeout)
        deadline = time.monotonic() + settings.timeout_capture
        while True:
            page.evaluate("() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))")
            for line in dialog.inner_text().splitlines():
                model_id = line.strip().removeprefix("models/")
                if _MODEL_ID.fullmatch(model_id) and not _UNSUPPORTED.search(model_id):
                    models[model_id] = {"id": model_id, "name": model_id, "capability": capability}
            advanced = dialog.evaluate("""root => {
                const scroller = [root, ...root.querySelectorAll('*')].find(el =>
                    el.clientHeight > 0 && el.scrollHeight > el.clientHeight
                    && /auto|scroll/.test(getComputedStyle(el).overflowY));
                if (!scroller || scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight) return false;
                const previous = scroller.scrollTop;
                scroller.scrollTop += scroller.clientHeight;
                return scroller.scrollTop > previous;
            }""")
            if not advanced:
                break
            if time.monotonic() >= deadline:
                raise RuntimeError("AI Studio 模型目录未完成加载，请检查当前账号与网络后重新获取")
    if not models:
        raise RuntimeError("AI Studio 页面未返回文本或图片模型 ID，请检查授权状态与模型选择器")
    return list(models.values())


def discover_models(context) -> list[dict]:
    if context is None:
        raise RuntimeError("AI Studio 浏览器尚未就绪，请先完成当前账号授权并刷新状态")
    page = context.new_page()
    try:
        page.goto(settings.studio_url, wait_until="domcontentloaded", timeout=settings.timeout_capture * 1000)
        if "accounts.google.com" in page.url:
            raise RuntimeError("当前 Google 授权已失效，请重新授权后获取模型目录")
        return read_model_picker(page)
    except RuntimeError:
        raise
    except Exception as error:
        raise RuntimeError("读取 AI Studio 模型选择器失败，请确认当前账号已登录、已完成人工条款确认且页面可用") from error
    finally:
        page.close()
