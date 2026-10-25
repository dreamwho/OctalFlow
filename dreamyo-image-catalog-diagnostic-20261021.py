"""Print model/capability facts; never print credentials or raw upstream errors."""
import json
import logging
import re


def describe(value, key=""):
    if isinstance(value, dict):
        return {str(k): describe(v, str(k)) for k, v in value.items()
                if not re.search(r"token|secret|cookie|authorization|email|session|url|header", str(k), re.I)}
    if isinstance(value, list):
        return [describe(item, key) for item in value]
    if isinstance(value, str):
        public = bool(re.fullmatch(r"(?:gpt-[a-zA-Z0-9_.-]+|chatgpt-image-[a-zA-Z0-9_.-]+|flare|sunburst|auto)", value)) or key in {"slug", "model_slug", "model", "model_id", "feature_name", "input_modalities", "output_modalities", "tools"}
        return value if public and re.fullmatch(r"[a-zA-Z0-9_.:/-]+", value) else "<string>"
    if value is None or isinstance(value, (bool, int, float)):
        return value
    return "<unknown>"


def main():
    logging.disable(logging.CRITICAL)
    from services.account_service import account_service
    from services.openai_backend_api import OpenAIBackendAPI
    accounts = account_service.list_accounts()
    account = next((item for item in accounts
                    if item.get("status") == "正常"
                    and account_service._is_account_selectable(item, allow_limited=False)
                    and item.get("access_token")), None)
    if account is None:
        print(json.dumps({"error": "没有可用正常账号"}, ensure_ascii=False))
        return
    with OpenAIBackendAPI(account["access_token"]) as backend:
        for label, fetch in (("model_catalog", backend.fetch_authenticated_model_catalog),
                             ("conversation_init", backend._get_conversation_init)):
            try:
                result = {"stage": label, "data": describe(fetch())}
            except Exception as exc:
                result = {"stage": label, "error_type": type(exc).__name__}
            print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
