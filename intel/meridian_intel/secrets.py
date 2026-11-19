"""API keys: GNOME Keyring (Secret Service) via `keyring`, falling back to environment variables.

Keys are never written to disk by this app. Env var name = MERIDIAN_KEY_<NAME> (upper case).
"""
from __future__ import annotations

import os

SERVICE = "meridian-intel"
KNOWN = {
    "anthropic": "AI analyst and watches (Claude API)",
    "aisstream": "Live ships (aisstream.io, free signup)",
    "hibp": "Email breach checks (haveibeenpwned.com, paid)",
    "opensky_user": "OpenSky account name (optional, more aircraft credits)",
    "opensky_pass": "OpenSky password",
    "opensanctions": "Sanctions/PEP lookups (phase 2)",
}


def _kr():
    try:
        import keyring  # noqa: PLC0415
        from keyring.backends import fail  # noqa: PLC0415

        if isinstance(keyring.get_keyring(), fail.Keyring):
            return None
        return keyring
    except Exception:
        return None


def get(name: str) -> str | None:
    env = os.environ.get(f"MERIDIAN_KEY_{name.upper()}")
    if env:
        return env
    if name == "anthropic" and os.environ.get("ANTHROPIC_API_KEY"):
        return os.environ["ANTHROPIC_API_KEY"]
    kr = _kr()
    if kr is None:
        return None
    try:
        return kr.get_password(SERVICE, name)
    except Exception:
        return None


def set_(name: str, value: str) -> None:
    kr = _kr()
    if kr is None:
        raise RuntimeError("No Secret Service keyring available (is GNOME Keyring unlocked?). "
                           f"Use the env var MERIDIAN_KEY_{name.upper()} instead.")
    kr.set_password(SERVICE, name, value)


def delete(name: str) -> None:
    kr = _kr()
    if kr is not None:
        try:
            kr.delete_password(SERVICE, name)
        except Exception:
            pass


def status() -> dict[str, bool]:
    return {k: bool(get(k)) for k in KNOWN}
