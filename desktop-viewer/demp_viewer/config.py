"""User-scoped settings — API base URL, saved email, saved access token."""
from __future__ import annotations

import json
import os
from dataclasses import dataclass, asdict
from pathlib import Path

APP_NAME = "CMC Viewer"

DEFAULT_API_BASE = os.environ.get("CMC_API_BASE", "http://172.16.205.21:4001")


def _config_dir() -> Path:
    if os.name == "nt":
        base = Path(os.environ.get("APPDATA", Path.home() / "AppData" / "Roaming"))
    else:
        base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    d = base / "CMC-Viewer"
    d.mkdir(parents=True, exist_ok=True)
    return d


CONFIG_FILE = _config_dir() / "config.json"


@dataclass
class Config:
    api_base: str = DEFAULT_API_BASE
    email: str = ""
    access_token: str | None = None
    grid_cols: int = 3
    grid_rows: int = 3
    wall_channel_ids: list[str] | None = None


def load_config() -> Config:
    if not CONFIG_FILE.exists():
        return Config()
    try:
        data = json.loads(CONFIG_FILE.read_text(encoding="utf-8"))
    except Exception:
        return Config()
    cfg = Config()
    for k, v in data.items():
        if hasattr(cfg, k):
            setattr(cfg, k, v)
    return cfg


def save_config(cfg: Config) -> None:
    CONFIG_FILE.write_text(json.dumps(asdict(cfg), indent=2), encoding="utf-8")
