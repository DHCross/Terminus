import argparse
import sys
import os
import json
from execution import run_condition_pipeline
from scoring import score_run
from models import RunLogger

# This requires the terminus project setup. We'll simulate a provider if none is available.
# We will try to load the Claude provider from the native system, or provide a dummy.

try:
    sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))
    from core.settings_manager import settings
    from core.chat.llm_providers import get_provider_by_key

    # Initialize the Claude provider for testing
    providers = settings.get('LLM_PROVIDERS', {})
    config = providers.get('claude', {}).copy()
    config['enabled'] = True
    provider = get_provider_by_key('claude', {'claude': config})

    def generate_with_claude(prompt: str) -> str:
        # Simulate an API call using the provider.
        # Note: The provider interface might be different.
        # Here we mock it if it's not straightforward.
        # Assuming provider.generate_text exists or similar.
        # For simplicity, if we don't have a direct method, we use a fallback mock.
        if hasattr(provider, 'generate'):
            return provider.generate(prompt)
        elif hasattr(provider, 'chat'):
            # Assuming it takes a list of messages
            response = provider.chat([{"role": "user", "content": prompt}])
            return response
        else:
            return f"[Simulated Output for Prompt]: {prompt[:50]}..."

    _generate_fn = generate_with_claude

except ImportError as e:
    print(f"Warning: Could not load actual LLM provider ({e}). Using mock provider.")
    def mock_generate(prompt: str) -> str:
        # A simple mock that tries to return JSON if asked, or just echoes the prompt.
        if "analyze the prompt and output a JSON object representing your reasoning process" in prompt:
            return '''```json
{
  "assumptions": ["Mock assumption 1"],
  "constraints": ["Mock constraint 1", "Mock constraint 2"],
  "uncertainties": ["Mock uncertainty 1"],
  "decision_points": ["Mock decision 1"]
}
```'''
        return f"Mock response for prompt: {prompt[:30]}..."

    _generate_fn = mock_generate

def run_experiment(base_prompt: str, single_pass: bool = True):
    print(f"Running Experiment: Reasoning Trace Injection")
    print(f"Base Prompt: '{base_prompt}'\n")
    print(f"Mode: {'Single-Pass' if single_pass else 'Two-Pass'}")

    logger = RunLogger(log_dir="experiments/reasoning_trace/runs")
    runs = []

    for condition in ['A', 'B', 'C', 'D', 'E']:
        print(f"\n--- Executing Condition {condition} ---")
        try:
            run = run_condition_pipeline(condition, base_prompt, _generate_fn, single_pass=single_pass)
            run = score_run(run)
            logger.log_run(run)
            runs.append(run)
            print(f"Condition {condition} complete. Run ID: {run.id}")
            print(f"Metrics: {run.metrics}")
            print(f"Flags: {run.flags}")
        except Exception as e:
            print(f"Error executing Condition {condition}: {e}")

    # Output side-by-side
    print("\n\n=== EXPERIMENT RESULTS ===\n")
    for r in runs:
        print(f"Condition {r.condition}")
        print(f"ID: {r.id}")
        print(f"Metrics: Contradiction: {r.metrics.contradiction_score:.2f}, Drift: {r.metrics.drift_score:.2f}, Meta-Density: {r.metrics.self_reference_density:.2f}")
        print(f"Flags: Overcorrection: {r.flags.overcorrection}, Self-Locking: {r.flags.self_locking}, Aesthetic: {r.flags.aesthetic_recursion}")
        print("Final Output:")
        print((r.model_output_reflected or r.model_output_initial)[:200] + "...\n")
        print("-" * 40)

    return runs

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Run Reasoning Trace Injection Experiment")
    parser.add_argument("prompt", type=str, help="The base prompt to test")
    parser.add_argument("--two-pass", action="store_true", help="Use two-pass execution flow")

    args = parser.parse_args()

    run_experiment(args.prompt, single_pass=not args.two_pass)
