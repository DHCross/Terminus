import uuid
from typing import Callable, Tuple
from models import ExperimentRun, ReasoningMirror
from capture import generate_reasoning_mirror
from conditions import build_condition_prompt
import logging

logger = logging.getLogger(__name__)

# Single-pass: Include trace in prompt with instruction: "Answer first, then audit against R1."
# Two-pass: 1) generate initial response, 2) inject trace, 3) generate final response.
# The prompt implies a single-pass or two-pass variant.

def run_condition_pipeline(
    condition: str,
    base_prompt: str,
    generate_fn: Callable[[str], str],
    single_pass: bool = True
) -> ExperimentRun:
    """
    Executes the pipeline for a single condition.
    generate_fn: A function that takes a prompt and returns the model's text response.
    single_pass: Boolean. True for single-pass variant, False for two-pass.
    """
    run_id = str(uuid.uuid4())
    logger.info(f"Starting run {run_id} for Condition {condition}")

    # 1) Trace Capture (if not Condition A)
    raw_trace = ""
    mirror = ReasoningMirror()
    if condition != 'A':
        try:
            raw_trace, mirror = generate_reasoning_mirror(base_prompt, generate_fn)
        except Exception as e:
            logger.error(f"Failed to capture trace: {e}")
            raw_trace = f"Error capturing trace: {e}"

    # 2) Execution Flow

    model_output_initial = None
    model_output_final = None

    if single_pass:
        # Single-pass variant
        # "Include trace in prompt with instruction: 'Answer first, then audit against R1.'"
        # Reflection Protocol (Phase 5) is appended when trace is present.
        prompt = build_condition_prompt(condition, base_prompt, raw_trace, mirror)

        if condition != 'A':
            reflection_protocol = """

After completing your answer, briefly audit:
* Did you ignore any critical constraint in R1?
* Did R1 contain bias or overreach?
* Revise only if it improves accuracy or coherence.
"""
            prompt += reflection_protocol

        model_output_final = generate_fn(prompt)

    else:
        # Two-pass variant
        # 1. Generate initial response
        # 2. Inject trace
        # 3. Generate final response

        # Initial response without trace
        model_output_initial = generate_fn(base_prompt)

        if condition == 'A':
            model_output_final = model_output_initial
        else:
            # Inject trace for the second pass
            # We build a prompt asking it to revise the initial response based on the trace
            trace_prefix = build_condition_prompt(condition, "", raw_trace, mirror)

            revision_prompt = f"""
{trace_prefix}

Your initial answer to the prompt:
{base_prompt}

Was:
{model_output_initial}

Now, consider the advisory information in R1.
After reviewing your initial answer against R1, briefly audit:
* Did you ignore any critical constraint in R1?
* Did R1 contain bias or overreach?
* Revise only if it improves accuracy or coherence.

Provide your final response below.
"""
            model_output_final = generate_fn(revision_prompt)

    # 3) Build ExperimentRun object (metrics/flags populated later)
    injected_trace = None
    if condition != 'A':
         injected_trace = {
             "raw": raw_trace,
             "structured": mirror.model_dump(mode='json')
         }

    run = ExperimentRun(
        id=run_id,
        base_prompt=base_prompt,
        condition=condition,
        injected_trace=injected_trace,
        model_output_initial=model_output_initial,
        model_output_reflected=model_output_final
    )

    return run
