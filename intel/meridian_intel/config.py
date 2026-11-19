"""Paths and settings. Everything lives under XDG dirs of the current user; nothing system-wide."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

APP = "meridian-intel"


def _xdg(var: str, default: str) -> Path:
    return Path(os.environ.get(var) or Path.home() / default) / APP


@dataclass
class Settings:
    data_dir: Path = field(default_factory=lambda: _xdg("XDG_DATA_HOME", ".local/share"))
    config_dir: Path = field(default_factory=lambda: _xdg("XDG_CONFIG_HOME", ".config"))
    host: str = "127.0.0.1"
    port: int = int(os.environ.get("MERIDIAN_INTEL_PORT", "8787"))
    demo: bool = os.environ.get("MERIDIAN_INTEL_DEMO", "") not in ("", "0", "false")
    # Feed cadence (seconds). Free sources are rate limited; keep these polite.
    aircraft_ttl: float = 10.0
    events_ttl: float = 900.0      # GDELT export is published every 15 min
    quote_ttl: float = 30.0
    history_ttl: float = 3600.0
    watch_interval: float = 3600.0
    model: str = os.environ.get("MERIDIAN_INTEL_MODEL", "claude-opus-5-5")
    user_agent: str = "meridian-intel/0.1 (+local workstation)"

    @property
    def db_path(self) -> Path:
        return self.data_dir / "intel.db"

    def ensure(self) -> None:
        for d in (self.data_dir, self.config_dir):
            d.mkdir(parents=True, exist_ok=True)
            os.chmod(d, 0o700)


settings = Settings()
