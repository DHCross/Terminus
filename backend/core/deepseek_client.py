"""
DeepSeek LLM Client Wrapper - OpenAI-compatible API with tool use and reasoning streaming support.
"""
import os
import json
import logging
from pathlib import Path
from typing import Generator, Optional, List, Dict, Any
import httpx

from config import settings
from core.claude_client import load_system_prompt

logger = logging.getLogger(__name__)


def _convert_tools_to_openai(tools: Optional[list]) -> Optional[List[Dict[str, Any]]]:
    """Convert Anthropic tool definitions to OpenAI-compatible function calling schemas."""
    if not tools:
        return None
    openai_tools = []
    for tool in tools:
        schema = tool.get("input_schema", {})
        openai_tools.append({
            "type": "function",
            "function": {
                "name": tool["name"],
                "description": tool.get("description", ""),
                "parameters": schema if schema else {"type": "object", "properties": {}},
            },
        })
    return openai_tools


def normalize_deepseek_model(model: str) -> str:
    aliases = {
        "deepseek-v4": "deepseek-v4-flash",
        "deepseek-v4-chat": "deepseek-v4-flash",
        "deepseek-v4-reasoner": "deepseek-v4-pro",
    }
    return aliases.get(model, model)


class DeepSeekClient:
    """Wrapper around DeepSeek OpenAI-compatible API with tool use and streaming."""

    def __init__(self, tools: Optional[list] = None):
        self.api_key = settings.DEEPSEEK_API_KEY
        self.base_url = settings.DEEPSEEK_BASE_URL.rstrip("/")
        if not self.base_url.endswith("/v1") and not self.base_url.endswith("/chat/completions"):
            # DeepSeek accepts https://api.deepseek.com or https://api.deepseek.com/v1
            self.api_endpoint = f"{self.base_url}/chat/completions"
        elif self.base_url.endswith("/v1"):
            self.api_endpoint = f"{self.base_url}/chat/completions"
        else:
            self.api_endpoint = self.base_url

        self.model = settings.DEEPSEEK_MODEL or "deepseek-v4-flash"
        self.max_tokens = settings.LLM_MAX_TOKENS
        self.system_prompt = load_system_prompt()
        self.conversation_history: List[Dict[str, Any]] = []
        self.raw_tools = tools
        self.openai_tools = _convert_tools_to_openai(tools)

    def _get_headers(self) -> Dict[str, str]:
        key = settings.DEEPSEEK_API_KEY or self.api_key
        return {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }

    def set_model(self, model: str) -> None:
        """Switch active DeepSeek model."""
        self.model = model
        settings.DEEPSEEK_MODEL = model
        self.system_prompt = load_system_prompt()

    def _build_messages(self) -> List[Dict[str, Any]]:
        """Build messages payload with system prompt, ensuring schema compliance."""
        messages = [{"role": "system", "content": self.system_prompt}]
        for msg in self.conversation_history:
            cleaned_msg = dict(msg)
            if "tool_calls" in cleaned_msg and cleaned_msg["tool_calls"]:
                fixed_tc = []
                for tc in cleaned_msg["tool_calls"]:
                    tc_dict = dict(tc)
                    if "type" not in tc_dict:
                        tc_dict["type"] = "function"
                    fixed_tc.append(tc_dict)
                cleaned_msg["tool_calls"] = fixed_tc
            messages.append(cleaned_msg)
        return messages

    def send_message(self, user_message: str) -> str:
        """
        Send a message with tool use support. Handles multi-turn tool loops automatically.
        """
        self.conversation_history.append({"role": "user", "content": user_message})

        active_model = normalize_deepseek_model(self.model)
        # DeepSeek Reasoner does not support function calling; other models support tools
        supports_tools = ("reasoner" not in active_model) and bool(self.openai_tools)

        with httpx.Client(timeout=120.0) as client:
            while True:
                payload: Dict[str, Any] = {
                    "model": active_model,
                    "messages": self._build_messages(),
                    "max_tokens": self.max_tokens,
                }
                if supports_tools:
                    payload["tools"] = self.openai_tools

                resp = client.post(
                    self.api_endpoint,
                    headers=self._get_headers(),
                    json=payload,
                )
                if not resp.is_success:
                    err_msg = f"DeepSeek API HTTP {resp.status_code}: {resp.text}"
                    logger.error(err_msg)
                    raise RuntimeError(err_msg)

                data = resp.json()
                choice = data.get("choices", [{}])[0]
                message = choice.get("message", {})

                # Record usage
                usage = data.get("usage", {})
                if usage:
                    try:
                        from core.usage_tracker import record_usage
                        in_tok = usage.get("prompt_tokens", 0) or 0
                        out_tok = usage.get("completion_tokens", 0) or 0
                        # DeepSeek cached tokens
                        c_read = usage.get("prompt_cache_hit_tokens", 0) or 0
                        c_write = usage.get("prompt_cache_miss_tokens", 0) or 0
                        record_usage(self.model, in_tok, out_tok, c_read, c_write)
                    except Exception as e:
                        logger.warning(f"Failed to record usage: {e}")

                tool_calls = message.get("tool_calls", [])
                if tool_calls and choice.get("finish_reason") == "tool_calls":
                    # Add assistant turn with tool_calls
                    self.conversation_history.append({
                        "role": "assistant",
                        "content": message.get("content") or "",
                        "tool_calls": tool_calls,
                    })

                    # Execute each tool
                    for tc in tool_calls:
                        tool_name = tc.get("function", {}).get("name", "")
                        raw_args = tc.get("function", {}).get("arguments", "{}")
                        try:
                            args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                        except Exception:
                            args = {}

                        try:
                            from core.tools import execute_tool
                            from core.tracer import record_tool_call
                            result = execute_tool(tool_name, args)
                            record_tool_call(tool_name, result)
                        except Exception as e:
                            logger.error(f"Tool execution failed [{tool_name}]: {e}")
                            result = f"Tool error: {e}"

                        self.conversation_history.append({
                            "role": "tool",
                            "tool_call_id": tc.get("id"),
                            "content": str(result),
                        })
                    continue  # Loop for next response

                # Final response
                final_text = message.get("content") or ""
                self.conversation_history.append({"role": "assistant", "content": final_text})
                return final_text

    def stream_with_thinking(self, user_message: str, thinking_budget: int = 8000) -> Generator[dict, None, None]:
        """
        Stream DeepSeek response.
        For deepseek-reasoner (R1), yields thinking chunks from `reasoning_content` delta and text chunks from `content`.
        For deepseek-chat (V3), yields text chunks from `content`.
        """
        if user_message:
            self.conversation_history.append({"role": "user", "content": user_message})

        active_model = normalize_deepseek_model(self.model)
        supports_tools = ("reasoner" not in active_model) and bool(self.openai_tools)

        with httpx.Client(timeout=120.0) as client:
            while True:
                payload: Dict[str, Any] = {
                    "model": active_model,
                    "messages": self._build_messages(),
                    "max_tokens": self.max_tokens,
                    "stream": True,
                }
                if supports_tools:
                    payload["tools"] = self.openai_tools

                with client.stream(
                    "POST",
                    self.api_endpoint,
                    headers=self._get_headers(),
                    json=payload,
                ) as response:
                    if not response.is_success:
                        err_text = response.read().decode("utf-8", errors="replace")
                        raise RuntimeError(f"DeepSeek API stream error {response.status_code}: {err_text}")

                    full_thinking = ""
                    full_text = ""
                    tool_calls_dict: Dict[int, Dict[str, Any]] = {}
                    finish_reason = None

                    for line in response.iter_lines():
                        if not line:
                            continue
                        line = line.strip()
                        if line.startswith("data: "):
                            data_str = line[6:].strip()
                            if data_str == "[DONE]":
                                break
                            try:
                                chunk = json.loads(data_str)
                            except Exception:
                                continue

                            # Check for usage info in final chunk if provided
                            if "usage" in chunk and chunk["usage"]:
                                try:
                                    from core.usage_tracker import record_usage
                                    u = chunk["usage"]
                                    in_tok = u.get("prompt_tokens", 0) or 0
                                    out_tok = u.get("completion_tokens", 0) or 0
                                    c_read = u.get("prompt_cache_hit_tokens", 0) or 0
                                    c_write = u.get("prompt_cache_miss_tokens", 0) or 0
                                    record_usage(self.model, in_tok, out_tok, c_read, c_write)
                                except Exception as e:
                                    logger.warning(f"Failed to record stream usage: {e}")

                            choices = chunk.get("choices", [])
                            if not choices:
                                continue
                            choice = choices[0]
                            delta = choice.get("delta", {})
                            finish_reason = choice.get("finish_reason") or finish_reason

                            # Handle R1 reasoning content
                            reasoning_chunk = delta.get("reasoning_content")
                            if reasoning_chunk:
                                full_thinking += reasoning_chunk
                                yield {"type": "thinking", "content": reasoning_chunk}

                            # Handle regular text content
                            text_chunk = delta.get("content")
                            if text_chunk:
                                full_text += text_chunk
                                yield {"type": "text", "content": text_chunk}

                            # Handle tool call streaming chunks
                            delta_tool_calls = delta.get("tool_calls", [])
                            for tc_chunk in delta_tool_calls:
                                idx = tc_chunk.get("index", 0)
                                if idx not in tool_calls_dict:
                                    tool_calls_dict[idx] = {
                                        "id": tc_chunk.get("id", ""),
                                        "type": "function",
                                        "function": {
                                            "name": tc_chunk.get("function", {}).get("name", ""),
                                            "arguments": tc_chunk.get("function", {}).get("arguments", ""),
                                        },
                                    }
                                else:
                                    if tc_chunk.get("id"):
                                        tool_calls_dict[idx]["id"] = tc_chunk["id"]
                                    if tc_chunk.get("type"):
                                        tool_calls_dict[idx]["type"] = tc_chunk["type"]
                                    if tc_chunk.get("function", {}).get("name"):
                                        tool_calls_dict[idx]["function"]["name"] += tc_chunk["function"]["name"]
                                    if tc_chunk.get("function", {}).get("arguments"):
                                        tool_calls_dict[idx]["function"]["arguments"] += tc_chunk["function"]["arguments"]

                    if finish_reason == "tool_calls" and tool_calls_dict:
                        collected_tool_calls = []
                        for k, v in sorted(tool_calls_dict.items()):
                            tc_item = dict(v)
                            if "type" not in tc_item:
                                tc_item["type"] = "function"
                            collected_tool_calls.append(tc_item)

                        self.conversation_history.append({
                            "role": "assistant",
                            "content": full_text or None,
                            "tool_calls": collected_tool_calls,
                        })

                        for tc in collected_tool_calls:
                            tool_name = tc.get("function", {}).get("name", "")
                            raw_args = tc.get("function", {}).get("arguments", "{}")
                            try:
                                args = json.loads(raw_args) if isinstance(raw_args, str) else raw_args
                            except Exception:
                                args = {}

                            try:
                                from core.tools import execute_tool
                                from core.tracer import record_tool_call
                                result = execute_tool(tool_name, args)
                                record_tool_call(tool_name, result)
                            except Exception as e:
                                logger.error(f"Tool execution failed [{tool_name}]: {e}")
                                result = f"Tool error: {e}"

                            self.conversation_history.append({
                                "role": "tool",
                                "tool_call_id": tc.get("id"),
                                "content": str(result),
                            })
                        continue  # Loop to stream the assistant's final response

                    # Done streaming
                    self.conversation_history.append({
                        "role": "assistant",
                        "content": full_text,
                    })
                    break

    def stream_message(self, user_message: str) -> Generator[str, None, None]:
        """
        Fast token streaming for voice mode (text only, no tool calling).
        """
        self.conversation_history.append({"role": "user", "content": user_message})

        with httpx.Client(timeout=60.0) as client:
            payload = {
                "model": self.model,
                "messages": self._build_messages(),
                "max_tokens": self.max_tokens,
                "stream": True,
            }

            with client.stream(
                "POST",
                self.api_endpoint,
                headers=self._get_headers(),
                json=payload,
            ) as response:
                if not response.is_success:
                    err_text = response.read().decode("utf-8", errors="replace")
                    raise RuntimeError(f"DeepSeek voice stream error {response.status_code}: {err_text}")

                full_response = ""
                for line in response.iter_lines():
                    if not line:
                        continue
                    line = line.strip()
                    if line.startswith("data: "):
                        data_str = line[6:].strip()
                        if data_str == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data_str)
                            delta = chunk.get("choices", [{}])[0].get("delta", {})
                            content = delta.get("content")
                            if content:
                                full_response += content
                                yield content
                        except Exception:
                            continue

                self.conversation_history.append({"role": "assistant", "content": full_response})

    def test_connection(self) -> Dict[str, Any]:
        """Test API key and connectivity with a lightweight ping."""
        key = settings.DEEPSEEK_API_KEY or self.api_key
        if not key:
            return {"status": "error", "error": "DEEPSEEK_API_KEY not configured"}

        try:
            with httpx.Client(timeout=10.0) as client:
                resp = client.post(
                    self.api_endpoint,
                    headers=self._get_headers(),
                    json={
                        "model": self.model or "deepseek-chat",
                        "messages": [{"role": "user", "content": "ping"}],
                        "max_tokens": 5,
                    },
                )
                if resp.is_success:
                    data = resp.json()
                    content = data.get("choices", [{}])[0].get("message", {}).get("content", "OK")
                    return {"status": "success", "response": content}
                return {"status": "error", "error": f"HTTP {resp.status_code}", "details": resp.text}
        except Exception as exc:
            return {"status": "error", "error": str(exc)}

    def clear_history(self) -> None:
        """Clear conversation history."""
        self.conversation_history = []

    def get_history(self) -> List[Dict[str, Any]]:
        """Get current conversation history."""
        return self.conversation_history
