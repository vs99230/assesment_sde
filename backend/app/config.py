from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    # Real values come from the environment / .env. Defaults are for local development only.
    database_url: str = "postgresql+psycopg://ops:ops@localhost:5432/ops"
    jwt_secret: str = "dev-only-secret-change-me-in-production-0123456789"
    jwt_expire_minutes: int = 720
    cors_origins: str = "http://localhost:5173"

    # Password hashing cost. Tests lower this so they run fast.
    password_iterations: int = 240_000

    # Outbox worker
    outbox_max_attempts: int = 5
    outbox_batch_size: int = 20
    worker_poll_seconds: float = 1.0

    # Seeding
    seed_items: int = 5000

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
