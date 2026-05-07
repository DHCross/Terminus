"""
ElevenLabs TTS Voice Engine for Terminus

Provides streaming text-to-speech using ElevenLabs v2 SDK.
Falls back to macOS `say` command if ElevenLabs is unavailable.

Voice: am_eric (Terminus default, as set in chat_defaults.json)
"""

import logging
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Generator, Optional

logger = logging.getLogger(__name__)

try:
    from elevenlabs import ElevenLabs, VoiceSettings
    ELEVENLABS_AVAILABLE = True
except ImportError:
    ELEVENLABS_AVAILABLE = False
    logger.warning("elevenlabs package not installed — TTS will fall back to macOS say")


# Default voice model and voice ID
# am_eric = Terminus default (warm, clear, male voice)
# For ElevenLabs, map to a real voice ID — "Adam" (pNInz6obpgDQGcFmaJgB) is a close match
DEFAULT_VOICE_ID = "pNInz6obpgDQGcFmaJgB"  # Adam — clean, warm, versatile
DEFAULT_MODEL = "eleven_turbo_v2_5"  # Lowest latency model (~300ms first chunk)


class VoiceEngine:
    """
    Text-to-speech engine with ElevenLabs streaming + macOS fallback.

    Usage:
        engine = VoiceEngine()

        # Streaming (low-latency, returns audio chunks)
        for chunk in engine.stream("Hello, I'm Terminus"):
            # chunk is bytes (MP3)
            send_to_client(chunk)

        # Single call returning full audio bytes
        audio = engine.synthesize("Good morning.")

        # Speak locally via macOS
        engine.speak_local("Testing local fallback.")
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        voice_id: str = DEFAULT_VOICE_ID,
        model: str = DEFAULT_MODEL,
    ):
        self.voice_id = voice_id
        self.model = model
        self.api_key = api_key or os.environ.get("ELEVENLABS_API_KEY", "")
        self.client: Optional[ElevenLabs] = None
        self.available = False

        if ELEVENLABS_AVAILABLE and self.api_key:
            try:
                self.client = ElevenLabs(api_key=self.api_key)
                self.available = True
                logger.info(f"VoiceEngine: ElevenLabs ready (model={model}, voice={voice_id})")
            except Exception as e:
                logger.warning(f"VoiceEngine: ElevenLabs init failed: {e}. Using macOS fallback.")
        else:
            if not ELEVENLABS_AVAILABLE:
                logger.info("VoiceEngine: elevenlabs not installed — using macOS say")
            elif not self.api_key:
                logger.info("VoiceEngine: ELEVENLABS_API_KEY not set — using macOS say")

    def stream(self, text: str) -> Generator[bytes, None, None]:
        """
        Stream audio chunks as MP3 bytes. First chunk arrives in ~300ms.

        Args:
            text: Text to synthesize

        Yields:
            bytes: MP3 audio chunks
        """
        if not text or not text.strip():
            return

        if self.available and self.client:
            try:
                audio_stream = self.client.text_to_speech.stream(
                    text=text,
                    voice_id=self.voice_id,
                    model_id=self.model,
                    voice_settings=VoiceSettings(
                        stability=0.5,
                        similarity_boost=0.8,
                        style=0.0,
                        use_speaker_boost=True,
                    ),
                    output_format="mp3_44100_128",
                )
                for chunk in audio_stream:
                    if chunk:
                        yield chunk
                return
            except Exception as e:
                logger.warning(f"VoiceEngine: ElevenLabs streaming failed: {e}. Falling back to macOS say.")

        # Fallback: generate via macOS say, yield as single chunk
        audio = self._macos_synthesize(text)
        if audio:
            yield audio

    def synthesize(self, text: str) -> bytes:
        """
        Synthesize text to audio and return full audio bytes.

        Args:
            text: Text to synthesize

        Returns:
            bytes: Full MP3 audio data (or AIFF if macOS fallback)
        """
        chunks = list(self.stream(text))
        return b"".join(chunks)

    def speak_local(self, text: str, rate: int = 200) -> bool:
        """
        Speak text through speakers using macOS say command.
        Blocks until audio finishes playing.

        Args:
            text: Text to speak
            rate: Words per minute (default 200)

        Returns:
            bool: True if successful
        """
        try:
            subprocess.run(
                ["say", "-r", str(rate), text],
                check=True,
                timeout=30,
            )
            return True
        except subprocess.CalledProcessError as e:
            logger.error(f"macOS say failed: {e}")
            return False
        except FileNotFoundError:
            logger.error("macOS say command not found (only works on macOS)")
            return False

    def _macos_synthesize(self, text: str) -> Optional[bytes]:
        """Generate audio via macOS say, return as bytes."""
        try:
            with tempfile.NamedTemporaryFile(suffix=".aiff", delete=False) as tmp:
                tmp_path = tmp.name

            subprocess.run(
                ["say", "-o", tmp_path, text],
                check=True,
                timeout=30,
            )

            with open(tmp_path, "rb") as f:
                return f.read()
        except Exception as e:
            logger.error(f"macOS synthesize failed: {e}")
            return None
        finally:
            try:
                Path(tmp_path).unlink(missing_ok=True)
            except Exception:
                pass

    @property
    def backend(self) -> str:
        """Which backend is active."""
        return "elevenlabs" if self.available else "macos_say"


# Global singleton
_voice_engine: Optional[VoiceEngine] = None


def get_voice_engine() -> VoiceEngine:
    """Get or create global VoiceEngine instance."""
    global _voice_engine
    if _voice_engine is None:
        from config import settings
        _voice_engine = VoiceEngine(
            api_key=settings.ELEVENLABS_API_KEY,
            voice_id=settings.VOICE_ID,
            model=settings.VOICE_MODEL,
        )
    return _voice_engine
