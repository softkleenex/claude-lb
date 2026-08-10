"""Extract token usage from Anthropic Messages API responses.

Two shapes: a plain JSON body (non-streaming) and an SSE event stream. In the stream,
``message_start`` carries the input/cache counts and ``message_delta`` carries a
running ``output_tokens`` total, so the last delta wins.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field

USAGE_FIELDS = (
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
)


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_creation_input_tokens: int = 0
    cache_read_input_tokens: int = 0
    model: str | None = None

    def as_dict(self) -> dict[str, int]:
        return {name: getattr(self, name) for name in USAGE_FIELDS}

    def merge(self, raw: dict) -> None:
        for name in USAGE_FIELDS:
            value = raw.get(name)
            if isinstance(value, int):
                # output_tokens in message_delta is cumulative, so take the larger value
                # rather than summing; input/cache counts only ever appear once.
                setattr(self, name, max(getattr(self, name), value))


@dataclass
class StreamUsageCollector:
    """Feeds raw SSE bytes through while sniffing usage out of the event payloads."""

    usage: Usage = field(default_factory=Usage)
    _buffer: bytes = b""

    def feed(self, chunk: bytes) -> None:
        self._buffer += chunk
        # Keep the trailing partial line in the buffer.
        *lines, self._buffer = self._buffer.split(b"\n")
        for line in lines:
            self._consume_line(line)

    def close(self) -> None:
        if self._buffer:
            self._consume_line(self._buffer)
            self._buffer = b""

    def _consume_line(self, line: bytes) -> None:
        stripped = line.strip()
        if not stripped.startswith(b"data:"):
            return
        payload = stripped[len(b"data:") :].strip()
        if not payload or payload == b"[DONE]":
            return
        try:
            event = json.loads(payload)
        except (ValueError, UnicodeDecodeError):
            return
        if not isinstance(event, dict):
            return

        message = event.get("message")
        if isinstance(message, dict):
            if isinstance(message.get("model"), str):
                self.usage.model = message["model"]
            if isinstance(message.get("usage"), dict):
                self.usage.merge(message["usage"])

        if isinstance(event.get("usage"), dict):
            self.usage.merge(event["usage"])


def parse_json_usage(body: bytes) -> Usage:
    usage = Usage()
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError):
        return usage
    if not isinstance(payload, dict):
        return usage
    if isinstance(payload.get("model"), str):
        usage.model = payload["model"]
    if isinstance(payload.get("usage"), dict):
        usage.merge(payload["usage"])
    return usage
