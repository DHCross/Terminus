"""
Terminus Backend Configuration
"""
import os
from pathlib import Path
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    """Application settings loaded from environment"""

    # API Keys
    ANTHROPIC_API_KEY: str = os.getenv("ANTHROPIC_API_KEY", "")
    ELEVENLABS_API_KEY: str = os.getenv("ELEVENLABS_API_KEY", "")

    # Server
    HOST: str = "localhost"
    PORT: int = 8000
    DEBUG: bool = False

    # LLM Model
    # Current Anthropic lineup: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5
    LLM_MODEL: str = "claude-sonnet-4-6"
    LLM_MAX_TOKENS: int = 4096

    # Voice (ElevenLabs)
    # Default: Adam (pNInz6obpgDQGcFmaJgB) — warm, clear, versatile
    VOICE_ID: str = "pNInz6obpgDQGcFmaJgB"
    VOICE_MODEL: str = "eleven_turbo_v2_5"  # Lowest latency

    # Paths
    BACKEND_DIR: Path = Path(__file__).parent
    DATA_DIR: Path = Path.home() / ".terminus" / "data"

    class Config:
        # .env lives at the repo root, one level above backend/
        env_file = str(Path(__file__).parent.parent / ".env")
        env_file_encoding = "utf-8"
        extra = "ignore"  # Repo .env has vars (tz, sapphire_native_dir) not in Settings
    
    def __init__(self, **data):
        super().__init__(**data)
        # Ensure data dir exists
        self.DATA_DIR.mkdir(parents=True, exist_ok=True)


# Global settings instance
settings = Settings()
