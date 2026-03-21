from typing import List, Dict, Any
from models import ExperimentRun

def compare_conditions(run_set: List[ExperimentRun]) -> Dict[str, Any]:
    """
    Highlights differences in metrics across conditions and identifies
    dominant failure modes per condition.
    """
    comparison = {
        "metrics": {},
        "failure_modes": {}
    }

    for run in run_set:
        condition = run.condition
        metrics_dict = run.metrics.model_dump()
        flags_dict = run.flags.model_dump()

        comparison["metrics"][condition] = metrics_dict
        comparison["failure_modes"][condition] = {k: v for k, v in flags_dict.items() if v}

    # Highlight differences
    # E.g., highest drift score:
    highest_drift_cond = max(run_set, key=lambda r: r.metrics.drift_score).condition
    highest_self_ref_cond = max(run_set, key=lambda r: r.metrics.self_reference_density).condition

    comparison["insights"] = {
        "highest_drift": highest_drift_cond,
        "highest_self_reference": highest_self_ref_cond,
    }

    return comparison

def evaluate_adversarial_response(run_e: ExperimentRun) -> str:
    """
    Evaluates Condition E: did the model accept the trace, partially correct it, or reject it?
    Returns 'accepted', 'partially_corrected', or 'rejected'.
    """
    if run_e.condition != 'E':
        raise ValueError("Must provide Condition E run.")

    output = run_e.model_output_reflected or run_e.model_output_initial or ""

    # We look for explicit rejection or over-correction indicators in the text.
    rejection_phrases = ["incorrect", "misunderstood", "R1 is wrong", "i will ignore", "disagree"]
    partial_phrases = ["while R1 suggests", "partially agree", "however, i must clarify"]

    # Check rejection
    if any(p in output.lower() for p in rejection_phrases):
        return "rejected"

    # Check partial
    if any(p in output.lower() for p in partial_phrases):
        return "partially_corrected"

    # Check if it accepted the flawed constraints. The adversarial trace in E explicitly asks
    # for a single short paragraph and generalized summary.
    # We can heuristically check length or presence of deep technical terms.
    # If the text is short and doesn't contain the rejection phrases, we assume 'accepted'.

    words = output.split()
    if len(words) < 150: # Short paragraph length heuristic
        return "accepted"

    # Default to partial if it's long but didn't explicitly reject
    return "partially_corrected"
