"""The dashboard SPA is served from the build directory with a client-route fallback."""

from __future__ import annotations

import pytest

from claude_lb.modules.dashboard import api as dashboard_api
from tests.test_proxy_api import make_client, ok_json

SPA_INDEX = '<!doctype html><html><head><title>Claude LB</title></head><body><div id="root"></div></body>'


@pytest.fixture
def built_spa(tmp_path, monkeypatch):
    (tmp_path / "assets").mkdir()
    (tmp_path / "index.html").write_text(SPA_INDEX, encoding="utf-8")
    (tmp_path / "assets" / "index-abc123.js").write_text("console.log(1);", encoding="utf-8")
    (tmp_path / "favicon.svg").write_text("<svg/>", encoding="utf-8")
    monkeypatch.setattr(dashboard_api, "STATIC_DIR", tmp_path)
    return tmp_path


async def test_root_and_client_routes_serve_index_uncached(built_spa):
    async for client in make_client(ok_json([])):
        for path in ("/", "/accounts", "/settings/advanced"):
            response = await client.get(path)
            assert response.status_code == 200, path
            assert 'id="root"' in response.text, path
            assert response.headers["cache-control"] == "no-cache", path


async def test_hashed_assets_are_cached_long(built_spa):
    async for client in make_client(ok_json([])):
        response = await client.get("/assets/index-abc123.js")
        missing = await client.get("/assets/index-gone.js")
        favicon = await client.get("/favicon.svg")
    assert response.status_code == 200
    assert response.text == "console.log(1);"
    assert "immutable" in response.headers["cache-control"]
    assert missing.status_code == 404
    assert favicon.status_code == 200
    assert "immutable" not in favicon.headers["cache-control"]


async def test_api_paths_are_never_swallowed_by_the_fallback(built_spa):
    async for client in make_client(ok_json([])):
        api_miss = await client.get("/api/does-not-exist")
        health = await client.get("/health")
        status = await client.get("/api/auth/status")
    assert api_miss.status_code == 404
    assert "root" not in api_miss.text
    assert health.json()["status"] == "ok"
    assert status.status_code == 200
    assert status.headers["content-type"].startswith("application/json")


async def test_path_traversal_does_not_escape_the_build_dir(built_spa):
    (built_spa.parent / "secret.txt").write_text("nope", encoding="utf-8")
    async for client in make_client(ok_json([])):
        response = await client.get("/..%2Fsecret.txt")
    assert "nope" not in response.text


async def test_without_a_build_the_legacy_dashboard_is_served(tmp_path, monkeypatch):
    monkeypatch.setattr(dashboard_api, "STATIC_DIR", tmp_path / "missing")
    async for client in make_client(ok_json([])):
        root = await client.get("/")
        deep = await client.get("/accounts")
    assert root.status_code == 200
    assert "<title>claude-lb</title>" in root.text
    assert deep.text == root.text
