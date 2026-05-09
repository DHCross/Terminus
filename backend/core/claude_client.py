"""
Claude LLM Client Wrapper — with tool use and streaming support
"""
import json
import logging
from pathlib import Path
from typing import Generator, Optional
from anthropic import Anthropic
from config import settings

logger = logging.getLogger(__name__)

FALLBACK_SYSTEM_PROMPT = """You are Terminus — a self-hosted AI assistant running natively on a Mac Mini M1. \
You are capable, thoughtful, and direct. You have access to tools: web search, file read/write, \
directory listing, shell commands, and reasoning-trace tools for self-audit. \
Use tools when they would genuinely help. Be concise unless depth is warranted. \
You know your own version history and codebase via /api/changelog and /api/version."""


def load_system_prompt(preset_name: str = "terminus_lab") -> str:
    """Assemble the active Terminus persona from Sapphire prompt pieces."""
    prompt_path = settings.BACKEND_DIR.parent / "sapphire-data" / "prompts" / "prompt_pieces.json"
    try:
        data = json.loads(prompt_path.read_text(encoding="utf-8"))
        components = data.get("components", {})
        preset = data.get("scenario_presets", {}).get(preset_name, {})
        if not preset:
            return FALLBACK_SYSTEM_PROMPT

        replacements = {
            "user_name": "Dan",
            "ai_name": "Terminus",
        }

        def render(section: str, key: str) -> str:
            text = components.get(section, {}).get(key, "")
            for name, value in replacements.items():
                text = text.replace("{" + name + "}", value)
            return text.strip()

        parts = []
        for section in ("character", "location", "relationship", "goals", "format", "scenario"):
            value = preset.get(section, "none")
            rendered = render(section, value)
            if rendered:
                parts.append(rendered)

        for section in ("extras", "emotions"):
            for key in preset.get(section, []):
                rendered = render(section, key)
                if rendered:
                    parts.append(rendered)

        prompt = "\n\n".join(parts) or FALLBACK_SYSTEM_PROMPT
        runtime_context = (
            f"Runtime context: your active provider is Anthropic Claude, "
            f"and your active model identifier is {settings.LLM_MODEL}."
        )
        return f"{prompt}\n\n{runtime_context}"
    except Exception as exc:
        logger.warning("Failed to load Terminus persona prompt: %s", exc)
        return FALLBACK_SYSTEM_PROMPT


class ClaudeClient:
    """Wrapper around Anthropic SDK with tool use, streaming, and conversation management."""

    def __init__(self, tools: Optional[list] = None):
        self.client = Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        self.model = settings.LLM_MODEL
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.system_prompt = load_system_prompt()
        self.conversation_history = []
        self.tools = tools  # list of tool defs; None = no tool use

    def set_model(self, model: str) -> None:
        """Switch the active Claude model for subsequent turns."""
        self.model = model
        settings.LLM_MODEL = model
        self.system_prompt = load_system_prompt()

    def send_message(self, user_message: str) -> str:
        """
        Send a message with optional tool use. Handles multi-turn tool loops automatically.

        Args:
            user_message: The user's input

        Returns:
            Claude's final response text (after all tool calls resolved)
        """
        self.conversation_history.append({"role": "user", "content": user_message})

        kwargs = dict(
            model=self.model,
            max_tokens=self.max_tokens,
            system=self.system_prompt,
            messages=self.conversation_history,
        )
        if self.tools:
            kwargs["tools"] = self.tools

        final_text = ""

        # Tool-use loop — Claude may call tools multiple times before a final text response
        while True:
            response = self.client.messages.create(**kwargs)

            # Check if Claude wants to use tools
            tool_use_blocks = [b for b in response.content if b.type == "tool_use"]
            text_blocks = [b for b in response.content if b.type == "text"]

            if response.stop_reason == "tool_use" and tool_use_blocks:
                # Add Claude's assistant turn (with tool_use blocks) to history
                self.conversation_history.append({
                    "role": "assistant",
                    "content": response.content,
                })

                # Execute each tool and build tool_result blocks
                tool_results = []
                for block in tool_use_blocks:
                    try:
                        from core.tools import execute_tool
                        from core.tracer import record_tool_call
                        result = execute_tool(block.name, block.input)
                        record_tool_call(block.name, result)
                    except Exception as e:
                        logger.error(f"Tool execution failed [{block.name}]: {e}")
                        result = f"Tool error: {e}"

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result),
                    })

                # Feed tool results back to Claude
                self.conversation_history.append({
                    "role": "user",
                    "content": tool_results,
                })
                kwargs["messages"] = self.conversation_history
                continue  # Loop — Claude will respond again with results

            # Final text response
            final_text = "".join(b.text for b in text_blocks) if text_blocks else ""
            break

        self.conversation_history.append({"role": "assistant", "content": final_text})
        return final_text

    def stream_with_thinking(self, user_message: str, thinking_budget: int = 8000) -> Generator[dict, None, None]:
        """
        Stream Claude's response with extended thinking blocks.
        Yields dicts with keys: type ("thinking" | "text"), content (str).
        Handles tool use in the thinking loop.

        Args:
            user_message: The user's input
            thinking_budget: Token budget for extended thinking (min 1024)

        Yields:
            dict: {"type": "thinking", "content": "..."} or {"type": "text", "content": "..."}
        """
        if user_message:
            self.conversation_history.append({"role": "user", "content": user_message})

        # Extended thinking requires max_tokens > budget; use at least budget + 2048
        max_tok = max(self.max_tokens, thinking_budget + 2048)

        kwargs = dict(
            model=self.model,
            max_tokens=max_tok,
            thinking={"type": "enabled", "budget_tokens": thinking_budget},
            system=self.system_prompt,
            messages=self.conversation_history,
        )
        if self.tools:
            kwargs["tools"] = self.tools

        full_thinking = ""
        full_text = ""

        while True:
            response = self.client.messages.create(**kwargs)

            # Collect thinking and text blocks
            thinking_parts = []
            text_parts = []
            tool_use_blocks = []

            for block in response.content:
                if block.type == "thinking":
                    thinking_parts.append(block.thinking)
                elif block.type == "text":
                    text_parts.append(block.text)
                elif block.type == "tool_use":
                    tool_use_blocks.append(block)

            # Yield thinking first
            if thinking_parts:
                combined = "\n\n".join(thinking_parts)
                full_thinking += combined
                yield {"type": "thinking", "content": combined}

            if response.stop_reason == "tool_use" and tool_use_blocks:
                # Yield any partial text before tool calls
                if text_parts:
                    chunk = "".join(text_parts)
                    full_text += chunk
                    yield {"type": "text", "content": chunk}

                self.conversation_history.append({
                    "role": "assistant",
                    "content": response.content,
                })

                tool_results = []
                for block in tool_use_blocks:
                    try:
                        from core.tools import execute_tool
                        from core.tracer import record_tool_call
                        result = execute_tool(block.name, block.input)
                        record_tool_call(block.name, result)
                    except Exception as e:
                        logger.error(f"Tool execution failed [{block.name}]: {e}")
                        result = f"Tool error: {e}"

                    tool_results.append({
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": str(result),
                    })

                self.conversation_history.append({
                    "role": "user",
                    "content": tool_results,
                })
                kwargs["messages"] = self.conversation_history
                continue

            # Final response text
            final_text = "".join(text_parts)
            full_text += final_text
            if final_text:
                yield {"type": "text", "content": final_text}
            break

        assistant_content = full_text or ""
        self.conversation_history.append({"role": "assistant", "content": assistant_content})

    def stream_message(self, user_message: str) -> Generator[str, None, None]:
        """
        Stream Claude's response token by token. Does NOT support tool use.
        Use for voice loop where latency matters and tools aren't needed.

        Args:
            user_message: The user's input

        Yields:
            str: Text chunks as they arrive
        """
        self.conversation_history.append({"role": "user", "content": user_message})

        full_response = ""
        with self.client.messages.stream(
            model=self.model,
            max_tokens=self.max_tokens,
            system=self.system_prompt,
            messages=self.conversation_history,
        ) as stream:
            for text_chunk in stream.text_stream:
                full_response += text_chunk
                yield text_chunk

        self.conversation_history.append({"role": "assistant", "content": full_response})

    def clear_history(self):
        """Clear conversation history."""
        self.conversation_history = []

    def get_history(self):
        """Get current conversation history."""
        return self.conversation_history
