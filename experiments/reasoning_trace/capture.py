import json
import logging
from typing import Dict, Any, Tuple
from pydantic import ValidationError
from models import ReasoningMirror

logger = logging.getLogger(__name__)

# To use an LLM provider, we might want a generic interface or just pass a callable.
# We will assume a callable `generate_fn(prompt: str) -> str` is provided.

def generate_reasoning_mirror(base_prompt: str, generate_fn) -> Tuple[str, ReasoningMirror]:
    """
    Given a base prompt, asks the model to generate a structured ReasoningMirror object
    *before* answering. We capture this explicitly to avoid relying on hidden CoT.

    Returns:
        raw_trace: The exact text the model generated.
        structured_trace: The parsed ReasoningMirror object.
    """
    capture_prompt = f"""
Given the following prompt, DO NOT answer it yet.
Instead, analyze the prompt and output a JSON object representing your reasoning process.
We need an explicit "Reasoning Mirror" object with this exact structure:

{{
  "assumptions": ["list of assumptions you are making"],
  "constraints": ["list of constraints you must follow"],
  "uncertainties": ["list of things you are uncertain about or risks"],
  "decision_points": ["list of key decisions you need to make to answer"]
}}

Return ONLY valid JSON.

Prompt:
{base_prompt}
"""
    raw_response = generate_fn(capture_prompt)

    # Try to parse the JSON
    try:
        # Simple extraction in case it's wrapped in markdown
        json_str = raw_response
        if "```json" in raw_response:
            json_str = raw_response.split("```json")[1].split("```")[0].strip()
        elif "```" in raw_response:
            json_str = raw_response.split("```")[1].split("```")[0].strip()

        data = json.loads(json_str)
        mirror = ReasoningMirror(**data)
        return raw_response, mirror
    except (json.JSONDecodeError, ValidationError) as e:
        logger.error(f"Failed to parse Reasoning Mirror: {e}\nRaw response: {raw_response}")
        # Return empty mirror on failure, but keep raw trace
        return raw_response, ReasoningMirror()

def get_compressed_reflection_note(mirror: ReasoningMirror) -> str:
    """
    Derives a compressed reflection note from the full mirror structure.
    Used for Condition C.
    """
    parts = []
    if mirror.constraints:
        parts.append(f"Key Constraints: {', '.join(mirror.constraints)}")
    if mirror.uncertainties:
        parts.append(f"Uncertainty Boundaries/Risks: {', '.join(mirror.uncertainties)}")

    if not parts:
        return "No significant constraints or risks identified."

    return "\n".join(parts)
