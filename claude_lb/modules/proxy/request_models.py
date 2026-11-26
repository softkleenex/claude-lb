"""Which models a proxied request asks for, so an API key's model policy can be applied.

Most model-bearing endpoints name the model at the top level (``model``). Message
batches name one per entry, at ``requests[*].params.model``. A key's allowlist and
enforced model have to see — and rewrite — every one of them, or a batch walks past
the policy.

For the model-bearing endpoints the body is read strictly: anything claude-lb cannot
read the same way upstream will (a compressed body, a BOM, duplicate keys, an
unexpected shape) is reported as *unreadable*, and keys with a model policy refuse it
rather than relay what they could not check.
"""

from __future__ import annotations

import json
from dataclasses import dataclass

# POST endpoints whose body names one model at the top level.
SINGLE_MODEL_PATHS = frozenset({"/v1/messages", "/v1/messages/count_tokens", "/v1/complete"})
# POST endpoint whose body names a model per entry.
BATCH_CREATE_PATH = "/v1/messages/batches"


class _Unreadable(ValueError):
    pass


@dataclass(frozen=True)
class RequestModels:
    models: tuple[str, ...] = ()
    batch: bool = False
    """A message-batch creation: ``models`` holds every entry's model."""
    unreadable: str | None = None
    """Why the body could not be checked, for an endpoint that carries a model."""

    @property
    def model(self) -> str | None:
        """The single model of an ordinary request (``None`` for a batch)."""
        return None if self.batch or not self.models else self.models[0]


def has_unsafe_segments(path: str) -> bool:
    """Dot segments or empty segments (``//``) that an upstream might normalize away,
    making a path claude-lb classified one way reach a different endpoint."""
    segments = path.rstrip("/").split("/")[1:]
    return any(segment in ("", ".", "..") for segment in segments)


def classify(method: str, path: str) -> str | None:
    """``single``, ``batch``, or ``None`` for an endpoint that names no model."""
    if method.upper() != "POST":
        return None
    path = path.rstrip("/")
    if path in SINGLE_MODEL_PATHS:
        return "single"
    if path == BATCH_CREATE_PATH:
        return "batch"
    return None


def _no_duplicates(pairs: list[tuple[str, object]]) -> dict:
    seen: dict[str, object] = {}
    for key, value in pairs:
        if key in seen:
            raise _Unreadable(f"duplicate key {key!r}")
        seen[key] = value
    return seen


def _strict_json(body: bytes) -> object:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise _Unreadable("the body is not UTF-8") from exc
    if text.startswith("﻿"):
        raise _Unreadable("the body starts with a byte-order mark")
    try:
        return json.loads(text, object_pairs_hook=_no_duplicates)
    except _Unreadable:
        raise
    except ValueError as exc:
        raise _Unreadable("the body is not valid JSON") from exc


def _batch_models(payload: dict) -> tuple[str, ...]:
    entries = payload.get("requests")
    if not isinstance(entries, list):
        raise _Unreadable("a batch needs a `requests` list")
    models: list[str] = []
    for entry in entries:
        params = entry.get("params") if isinstance(entry, dict) else None
        model = params.get("model") if isinstance(params, dict) else None
        if not isinstance(model, str):
            raise _Unreadable("every batch entry needs `params.model`")
        models.append(model)
    return tuple(models)


def _peek(body: bytes) -> tuple[str, ...]:
    """Best effort, for endpoints that carry no model: whatever ``model`` says, if anything."""
    try:
        payload = json.loads(body) if body else None
    except (ValueError, UnicodeDecodeError):
        return ()
    model = payload.get("model") if isinstance(payload, dict) else None
    return (model,) if isinstance(model, str) else ()


def inspect(method: str, path: str, body: bytes, *, content_encoding: str | None = None) -> RequestModels:
    kind = classify(method, path)
    if kind is None:
        return RequestModels(models=_peek(body))
    if content_encoding and content_encoding.strip().lower() not in ("", "identity"):
        return RequestModels(batch=kind == "batch", unreadable="the body is compressed (content-encoding)")
    if not body:
        return RequestModels(batch=kind == "batch")
    try:
        payload = _strict_json(body)
        if not isinstance(payload, dict):
            raise _Unreadable("the body is not a JSON object")
        if kind == "batch":
            return RequestModels(models=_batch_models(payload), batch=True)
        model = payload.get("model")
        if model is not None and not isinstance(model, str):
            raise _Unreadable("`model` is not a string")
        return RequestModels(models=(model,) if model is not None else ())
    except _Unreadable as exc:
        return RequestModels(batch=kind == "batch", unreadable=str(exc))


def enforce(method: str, path: str, body: bytes, model: str) -> bytes:
    """Rewrite every model the request names to ``model`` (a key's enforced model).

    Only bodies that already name a model are touched; anything else is relayed as
    sent (admission has already refused what it could not read).
    """
    try:
        payload = json.loads(body) if body else None
    except (ValueError, UnicodeDecodeError):
        return body
    if not isinstance(payload, dict):
        return body
    changed = False
    if classify(method, path) == "batch":
        for entry in payload.get("requests") or []:
            params = entry.get("params") if isinstance(entry, dict) else None
            if isinstance(params, dict) and isinstance(params.get("model"), str) and params["model"] != model:
                params["model"] = model
                changed = True
    elif isinstance(payload.get("model"), str) and payload["model"] != model:
        payload["model"] = model
        changed = True
    if not changed:
        return body
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
