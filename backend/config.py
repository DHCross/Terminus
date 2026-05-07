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
    
    # Server
    HOST: str = "localhost"
    PORT: int = 8000
    DEBUG: bool = False
    
    # LLM Model
    # Current Anthropic lineup: claude-opus-4-7, claude-sonnet-4-6, claude-haiku-4-5
    LLM_MODEL: str = "claude-sonnet-4-6"
    LLM_MAX_TOKENS: int = 2048
    
    # Paths
    BACKEND_DIR: Path = Path(__file__).parent
    DATA_DIR: Path = Path.home() / ".terminus" / "data"
    
    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
    
    def __init__(self, **data):
        super().__init__(**data)
        # Ensure data dir exists
        self.DATA_DIR.mkdir(parents=True, exist_ok=True)


# Global settings instance
settings = Settings()
