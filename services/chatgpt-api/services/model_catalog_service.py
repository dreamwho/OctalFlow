from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
from threading import Lock
from typing import Any

from contracts.models import (
    ModelCatalogCapabilities,
    ModelCatalogDefaults,
    ModelCatalogSource,
    ModelCatalogView,
)
from services.account_service import account_service
from services.config import config
from utils.helper import CODEX_IMAGE_MODEL


FALLBACK_CHAT_MODELS = [
    "auto",
    "gpt-5",
    "gpt-5-1",
    "gpt-5-2",
    "gpt-5-3",
    "gpt-5-3-mini",
    "gpt-5-5",
    "gpt-5-mini",
]

# 本地预置兼容型号，不代表当前账号实时上游目录中的型号。
GPT_IMAGE_25_IMAGE_MODELS = [
    "gpt-image-2.5",
    "gpt-image-2.5-flare",
    "gpt-image-2.5-sunburst",
    "gpt-image-2.5-exact",
    "gpt-image-2.5-flare-exact",
    "gpt-image-2.5-sunburst-exact",
]

FALLBACK_IMAGE_MODELS = [
    "gpt-image-2",
    *GPT_IMAGE_25_IMAGE_MODELS,
]
UPSTREAM_MODELS_ENDPOINT = "/backend-api/models?history_and_training_disabled=false"
IMAGE_CATALOG_WARNING = (
    "上游目录未返回独立图片型号，图片列表沿用旧版兼容目录；"
    "Flare、Sunburst、exact 等名称不代表独立型号选择，现有 Web 生图链路仍由上游自动分配。"
)


class ModelCatalogRefreshBusyError(RuntimeError):
    pass


class ModelCatalogAccountUnavailableError(RuntimeError):
    pass


class ModelCatalogUpstreamError(RuntimeError):
    pass


def _normalize_list(raw: object) -> list[str]:
    if not isinstance(raw, list):
        return []
    values: list[str] = []
    seen: set[str] = set()
    for item in raw:
        value = str(item or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        values.append(value)
    return values


def _settings_dict(value: object) -> dict[str, Any]:
    return value if isinstance(value, dict) else {}


def _configured_chat_models(settings: dict[str, Any]) -> list[str]:
    catalog = _settings_dict(settings.get("model_catalog"))
    explicit = _normalize_list(catalog.get("chat_models"))
    if explicit:
        return explicit

    combined: list[str] = []
    for key in ("base_chat_models", "specialized_chat_models", "image_capable_chat_models"):
        for model in _normalize_list(catalog.get(key)):
            if model not in combined:
                combined.append(model)
    return combined


def _configured_image_models(settings: dict[str, Any]) -> list[str]:
    image_generation = _settings_dict(settings.get("image_generation"))
    catalog = _settings_dict(settings.get("model_catalog"))
    for source in (
        image_generation.get("model_options"),
        catalog.get("image_api_models"),
        image_generation.get("supported_models"),
    ):
        models = _normalize_list(source)
        if models:
            return models
    return []


def _image_models_from_accounts(accounts: list[dict[str, Any]]) -> list[str]:
    available_accounts = [
        account
        for account in accounts
        if isinstance(account, dict) and account_service._is_image_account_available(account)
    ]
    if not available_accounts:
        return []

    models: list[str] = ["gpt-image-2", *GPT_IMAGE_25_IMAGE_MODELS]
    codex_types = {
        normalized
        for account in available_accounts
        if account_service._normalize_source_type(account.get("source_type")) == "codex"
        and (normalized := account_service._normalize_account_type(account.get("type")))
    }

    if codex_types & {"Plus", "Team", "Pro"}:
        models.append(CODEX_IMAGE_MODEL)
    for plan_type in ("Plus", "Team", "Pro"):
        if plan_type in codex_types:
            models.append(f"{plan_type.lower()}-{CODEX_IMAGE_MODEL}")
    return models


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def _generated_at() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _revision(payload: dict[str, Any]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()[:16]


class ModelCatalogService:
    """Build the model facts shared by management and OpenAI-compatible APIs."""

    def __init__(self) -> None:
        self._refresh_lock = Lock()

    @staticmethod
    def _discovery_snapshot(settings: dict[str, Any]) -> dict[str, Any] | None:
        snapshot = settings.get("model_catalog_snapshot")
        if not isinstance(snapshot, dict) or snapshot.get("source") != "upstream":
            return None
        return snapshot

    @staticmethod
    def _parse_upstream_payload(payload: object) -> tuple[list[str], list[str]]:
        if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
            raise ValueError("上游模型目录格式无效")
        chat_models: list[str] = []
        image_models: list[str] = []
        for item in payload["models"]:
            if not isinstance(item, dict):
                continue
            slug = str(item.get("slug") or "").strip()
            if not slug:
                continue
            modalities = item.get("output_modalities")
            has_image_output = (
                isinstance(modalities, (list, tuple, set))
                and any(str(value).strip().casefold() == "image" for value in modalities)
            )
            target = image_models if slug.startswith("gpt-image-") or has_image_output else chat_models
            if slug not in target:
                target.append(slug)
        if not chat_models and not image_models:
            raise ValueError("上游模型目录为空")
        return chat_models, image_models

    @staticmethod
    def _select_account() -> tuple[str, dict[str, Any]]:
        candidate = next((
            account for account in account_service.list_accounts()
            if isinstance(account, dict)
            and account.get("status") == "正常"
            and account_service._is_account_selectable(account, allow_limited=False)
            and str(account.get("access_token") or "").strip()
        ), None)
        if candidate is None:
            raise ModelCatalogAccountUnavailableError("没有可用于模型目录同步的正常账号")

        from services.account_service import TerminalRefreshTokenError, RefreshCredentialsChangedError

        token = str(candidate.get("access_token") or "").strip()
        try:
            usable_token = account_service.ensure_access_token(
                token,
                event="model_catalog_refresh",
                raise_on_error=True,
            )
        except (TerminalRefreshTokenError, RefreshCredentialsChangedError) as exc:
            raise ModelCatalogAccountUnavailableError(
                "所选正常账号的访问令牌刷新失败，未改用其他账号"
            ) from exc
        except Exception as exc:
            raise ModelCatalogAccountUnavailableError(
                "所选正常账号的访问令牌不可用，未改用其他账号"
            ) from exc
        if not usable_token:
            raise ModelCatalogAccountUnavailableError("所选正常账号没有可用访问令牌")
        return usable_token, candidate

    def refresh(self) -> ModelCatalogView:
        if not self._refresh_lock.acquire(blocking=False):
            raise ModelCatalogRefreshBusyError("模型目录正在刷新，请稍后再试")
        try:
            from services.openai_backend_api import OpenAIBackendAPI

            token, account = self._select_account()
            try:
                with OpenAIBackendAPI(token) as backend:
                    payload = backend.fetch_authenticated_model_catalog()
            except Exception as exc:
                raise ModelCatalogUpstreamError("GPTAPI 上游模型目录请求失败，请检查账号与代理连接") from exc
            try:
                chat_models, image_models = self._parse_upstream_payload(payload)
            except ValueError as exc:
                raise ModelCatalogUpstreamError(str(exc)) from exc

            fetched_at = _generated_at()
            account_id = str(account.get("management_id") or "").strip()
            if not account_id:
                raise ModelCatalogAccountUnavailableError("所选账号缺少公开账号 ID")
            label = str(account.get("email") or account.get("name") or "GPTAPI 账号").strip()
            snapshot = {
                "source": "upstream",
                "chat_models": chat_models,
                "image_models": image_models,
                "fetched_at": fetched_at,
                "account_id": account_id,
                "account_label": label,
                "endpoint": UPSTREAM_MODELS_ENDPOINT,
            }
            config.update({"model_catalog_snapshot": snapshot})
            return self.view()
        finally:
            self._refresh_lock.release()

    def view(self) -> ModelCatalogView:
        settings = config.get()
        snapshot = self._discovery_snapshot(settings)
        if snapshot is not None:
            chat_models = _unique(_normalize_list(snapshot.get("chat_models")))
            image_models = _unique(_normalize_list(snapshot.get("image_models")))
            image_source = "upstream"
            if not image_models:
                configured = _configured_image_models(settings)
                account_models = _image_models_from_accounts(account_service.list_accounts()) if not configured else []
                image_models = _unique(configured or account_models or list(FALLBACK_IMAGE_MODELS))
                image_source = "config" if configured else "accounts" if account_models else "fallback"
            all_models = _unique([*chat_models, *image_models])
            high_resolution_models = [
                model for model in image_models
                if model in GPT_IMAGE_25_IMAGE_MODELS
                or model == CODEX_IMAGE_MODEL
                or model.endswith(f"-{CODEX_IMAGE_MODEL}")
            ]
            defaults = {
                "chat_model": chat_models[0] if chat_models else None,
                "image_model": (
                    "gpt-image-2" if image_source != "upstream" and "gpt-image-2" in image_models
                    else image_models[0]
                ),
            }
            capabilities = {
                "image_upscale": bool(settings.get("image_upscale_enabled")),
                "high_resolution_image_models": high_resolution_models,
            }
            source = {"chat": "upstream", "image": image_source}
            revision_payload = {
                "chat_models": chat_models,
                "image_models": image_models,
                "defaults": defaults,
                "capabilities": capabilities,
                "source": source,
                "discovery": snapshot,
            }
            return ModelCatalogView(
                generated_at=str(snapshot.get("fetched_at") or _generated_at()),
                revision=_revision(revision_payload),
                chat_models=tuple(chat_models),
                image_models=tuple(image_models),
                all_models=tuple(all_models),
                defaults=ModelCatalogDefaults(**defaults),
                capabilities=ModelCatalogCapabilities(
                    image_upscale=capabilities["image_upscale"],
                    high_resolution_image_models=tuple(high_resolution_models),
                ),
                source=ModelCatalogSource(**source),
                discovery={
                    "account_id": str(snapshot.get("account_id") or ""),
                    "account_label": str(snapshot.get("account_label") or "GPTAPI 账号"),
                    "fetched_at": str(snapshot.get("fetched_at") or ""),
                    "endpoint": str(snapshot.get("endpoint") or UPSTREAM_MODELS_ENDPOINT),
                },
                warnings=() if image_source == "upstream" else (IMAGE_CATALOG_WARNING,),
            )
        configured_chat_models = _configured_chat_models(settings)
        configured_image_models = _configured_image_models(settings)

        chat_source = "config" if configured_chat_models else "fallback"
        chat_models = _unique(configured_chat_models or list(FALLBACK_CHAT_MODELS))

        if configured_image_models:
            image_source = "config"
            image_models = _unique(configured_image_models)
        else:
            account_models = _image_models_from_accounts(account_service.list_accounts())
            image_source = "accounts" if account_models else "fallback"
            image_models = _unique(account_models or list(FALLBACK_IMAGE_MODELS))

        all_models = _unique([*chat_models, *image_models])
        high_resolution_models = [
            model
            for model in image_models
            if model in GPT_IMAGE_25_IMAGE_MODELS
            or model == CODEX_IMAGE_MODEL
            or model.endswith(f"-{CODEX_IMAGE_MODEL}")
        ]
        defaults = {
            "chat_model": "auto" if "auto" in chat_models else chat_models[0],
            "image_model": "gpt-image-2" if "gpt-image-2" in image_models else image_models[0],
        }
        capabilities = {
            "image_upscale": bool(settings.get("image_upscale_enabled")),
            "high_resolution_image_models": high_resolution_models,
        }
        source = {"chat": chat_source, "image": image_source}
        revision_payload = {
            "chat_models": chat_models,
            "image_models": image_models,
            "defaults": defaults,
            "capabilities": capabilities,
            "source": source,
        }

        return ModelCatalogView(
            generated_at=_generated_at(),
            revision=_revision(revision_payload),
            chat_models=tuple(chat_models),
            image_models=tuple(image_models),
            all_models=tuple(all_models),
            defaults=ModelCatalogDefaults(**defaults),
            capabilities=ModelCatalogCapabilities(
                image_upscale=capabilities["image_upscale"],
                high_resolution_image_models=tuple(high_resolution_models),
            ),
            source=ModelCatalogSource(**source),
        )


model_catalog_service = ModelCatalogService()


def get_model_catalog() -> ModelCatalogView:
    return model_catalog_service.view()
