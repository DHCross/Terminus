"""
Claude LLM Client Wrapper — with tool use and streaming support
"""
import logging
from typing import Generator, Optional
from anthropic import Anthropic
from config import settings

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are Terminus — a self-hosted AI assistant running natively on a Mac Mini M1. \
You are capable, thoughtful, and direct. You have access to tools: web search, file read/write, \
directory listing, shell commands, and reasoning-trace tools for self-audit. \
Use tools when they would genuinely help. Be concise unless depth is warranted. \
You know your own version history and codebase via /api/changelog and /api/version."""


class ClaudeClient:
    """Wrapper around Anthropic SDK with tool use, streaming, and conversation management."""

    def __init__(self, tools: Optional[list] = None):
        self.client = Anthropic(api_key=settings.ANTHROPIC_API_KEY)
        self.model = settings.LLM_MODEL
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.conversation_history = []
        self.tools = tools  # list of tool defs; None = no tool use

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
            system=SYSTEM_PROMPT,
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
            system=SYSTEM_PROMPT,
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
