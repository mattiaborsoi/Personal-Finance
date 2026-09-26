"""Security behaviour: startup guards, token revocation, login throttling, upload hygiene."""

from __future__ import annotations

from pathlib import Path

import pytest

from app import auth
from app.config import ConfigError, Settings
from app.routers import auth as auth_router
from tests.conftest import requires_db


def _settings(**overrides) -> Settings:
    base = {
        "secret_key": "a" * 40,
        "primary_password": "primary-strong-pass",
        "secondary_password": "secondary-strong-pass",
        "_env_file": None,
    }
    base.update(overrides)
    return Settings(**base)


class TestStartupGuards:
    def test_good_settings_pass(self):
        auth.validate_security_settings(_settings())

    @pytest.mark.parametrize(
        "overrides, fragment",
        [
            ({"secret_key": "change-me-to-a-long-random-string"}, "SECRET_KEY"),
            ({"secret_key": "short"}, "SECRET_KEY"),
            ({"primary_password": "change-me-primary"}, "PRIMARY_PASSWORD"),
            ({"secondary_password": "short"}, "SECONDARY_PASSWORD"),
            ({"primary_password": "same-password-1", "secondary_password": "same-password-1"}, "must differ"),
        ],
    )
    def test_placeholders_and_weak_values_are_refused(self, overrides, fragment):
        with pytest.raises(ConfigError, match=fragment):
            auth.validate_security_settings(_settings(**overrides))

    def test_default_values_are_refused(self):
        """The class defaults (mirroring .env.example) must never run in production."""
        with pytest.raises(ConfigError):
            auth.validate_security_settings(Settings.model_construct())


class TestTokens:
    def test_password_rotation_invalidates_tokens(self):
        settings = _settings()
        token = auth.create_token(settings, "primary")
        assert auth.verify_token(settings, token) == "primary"
        rotated = settings.model_copy(update={"primary_password": "another-strong-pass"})
        with pytest.raises(Exception) as exc:
            auth.verify_token(rotated, token)
        assert exc.value.status_code == 401
        # The other role's sessions survive.
        secondary = auth.create_token(settings, "secondary")
        assert auth.verify_token(rotated, secondary) == "secondary"

    def test_token_from_another_secret_is_rejected(self):
        token = auth.create_token(_settings(secret_key="b" * 40), "primary")
        with pytest.raises(Exception) as exc:
            auth.verify_token(_settings(), token)
        assert exc.value.status_code == 401


@requires_db
class TestLoginThrottle:
    def test_lockout_after_repeated_failures(self, client):
        auth_router.reset_login_throttle()
        for _ in range(auth_router.MAX_FAILURES):
            assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
        locked = client.post("/api/auth/login", json={"password": "primary-pass"})
        assert locked.status_code == 429
        assert "Retry-After" in locked.headers
        # Another address is unaffected.
        other = client.post(
            "/api/auth/login", json={"password": "primary-pass"}, headers={"X-Forwarded-For": "10.0.0.9"}
        )
        assert other.status_code == 200
        auth_router.reset_login_throttle()
        assert client.post("/api/auth/login", json={"password": "primary-pass"}).status_code == 200

    def test_throttle_keys_on_the_proxy_vouched_address_not_the_client_supplied_one(self, client):
        # nginx overwrites X-Forwarded-For with the connecting address; should a proxy append
        # instead, the last entry is still the trustworthy one. Rotating the first entry must
        # neither dodge the lockout nor let a stranger aim it at someone else's address.
        auth_router.reset_login_throttle()

        def login(password: str, forwarded_for: str):
            headers = {"X-Forwarded-For": forwarded_for}
            return client.post("/api/auth/login", json={"password": password}, headers=headers)

        for n in range(auth_router.MAX_FAILURES):
            assert login("wrong", f"10.9.9.{n}, 192.168.1.20").status_code == 401
        assert login("wrong", "10.9.9.99, 192.168.1.20").status_code == 429
        # The address a stranger tried to target is untouched: only the last entry counts.
        assert login("primary-pass", "192.168.1.20, 192.168.1.30").status_code == 200
        auth_router.reset_login_throttle()

    def test_success_clears_failures(self, client):
        auth_router.reset_login_throttle()
        for _ in range(auth_router.MAX_FAILURES - 1):
            client.post("/api/auth/login", json={"password": "wrong"})
        assert client.post("/api/auth/login", json={"password": "primary-pass"}).status_code == 200
        for _ in range(auth_router.MAX_FAILURES - 1):
            client.post("/api/auth/login", json={"password": "wrong"})
        assert client.post("/api/auth/login", json={"password": "primary-pass"}).status_code == 200


@requires_db
class TestUploadHygiene:
    def test_uploaded_file_is_removed_after_ingestion(self, client, primary_headers, tmp_path, fake_llm):
        from tests.fixtures import generate
        from tests.test_api import keyword_llm, upload

        fake_llm.handler = keyword_llm
        fx = generate.build_all(tmp_path / "fx")
        resp = upload(client, primary_headers, fx["hsbc_table_pdf"])
        assert resp.status_code == 200, resp.text
        upload_dir = Path(tmp_path / "uploads")
        assert upload_dir.exists()
        assert list(upload_dir.iterdir()) == []
        assert (upload_dir.stat().st_mode & 0o777) == 0o700

    def test_search_wildcards_are_literal(self, client, primary_headers, seeded_db, config):
        from tests.factories import make_transaction

        make_transaction(seeded_db, config, raw_description="TESCO STORES 1234", amount="-5.00")
        make_transaction(seeded_db, config, raw_description="100% ORGANIC", amount="-6.00")
        seeded_db.commit()
        everything = client.get("/api/transactions", headers=primary_headers, params={"q": "%"}).json()
        assert everything["total"] == 1
        assert everything["items"][0]["raw_description"] == "100% ORGANIC"
        assert client.get("/api/transactions", headers=primary_headers, params={"q": "_"}).json()["total"] == 0
