import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_MODELS_PATH = Path(__file__).resolve().parent.parent / "config" / "models.yaml"
DEFAULT_CORS_ORIGINS = ("http://localhost:8081",)  # Expo 웹 개발 서버


@dataclass(frozen=True)
class Settings:
    supabase_url: str = ""
    supabase_service_role_key: str = ""
    supabase_db_url: str = ""
    hook_secret: str = ""
    force_mock: bool = False
    models_path: Path = DEFAULT_MODELS_PATH
    cors_origins: tuple[str, ...] = DEFAULT_CORS_ORIGINS

    @classmethod
    def from_env(cls) -> "Settings":
        # 키가 없어도 서버는 뜬다: 모두 빈 값 허용.
        return cls(
            supabase_url=os.environ.get("SUPABASE_URL", ""),
            supabase_service_role_key=os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
            supabase_db_url=os.environ.get("SUPABASE_DB_URL", ""),
            hook_secret=os.environ.get("HOOK_SECRET", ""),
            force_mock=os.environ.get("FORCE_MOCK", "").lower() in {"1", "true"},
            models_path=Path(os.environ.get("MODELS_PATH") or DEFAULT_MODELS_PATH),
            cors_origins=tuple(o for o in (x.strip() for x in os.environ.get("CORS_ORIGINS", "").split(",")) if o)
            or DEFAULT_CORS_ORIGINS,
        )
