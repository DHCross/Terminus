import re
from typing import Dict, Any
from models import ExperimentRun, Metrics, Flags

def calculate_contradiction_score(response: str, trace_content: str) -> float:
    """
    Detect internal inconsistencies.
    A basic semantic check: count opposing words or negative phrases against constraints.
    Returns a score 0.0 - 1.0
    """
    # Placeholder heuristic:
    score = 0.0
    negations = ["not", "never", "cannot", "impossible", "contradict", "ignore"]
    count = sum(1 for word in negations if word in response.lower())
    if count > 2:
        score = min(count * 0.1, 1.0)
    return score

def calculate_drift_score(response: str, base_prompt: str) -> float:
    """
    Compare response to base prompt intent.
    Returns a score 0.0 - 1.0. Higher means more drift.
    """
    # Placeholder heuristic: word overlap
    prompt_words = set(re.findall(r'\w+', base_prompt.lower()))
    response_words = set(re.findall(r'\w+', response.lower()))
    if not prompt_words:
        return 0.0
    overlap = len(prompt_words.intersection(response_words)) / len(prompt_words)
    return 1.0 - overlap

def calculate_self_reference_density(response: str) -> float:
    """
    Count meta-language ("I am", "this system", etc.).
    Returns density per 100 words.
    """
    words = re.findall(r'\w+', response.lower())
    total_words = len(words)
    if total_words == 0:
        return 0.0

    phrases = ["i am", "my reasoning", "this system", "as an ai", "i will", "my instructions"]
    count = 0
    for phrase in phrases:
        count += response.lower().count(phrase)

    return (count / total_words) * 100

def calculate_specificity_score(response: str) -> float:
    """
    Measure presence of user-specific details.
    Returns score 0.0 - 1.0
    """
    # Placeholder heuristic: look for numbers, capitalization, technical terms
    words = re.findall(r'\w+', response)
    capitalized = sum(1 for w in words if w.istitle())
    numbers = sum(1 for w in words if w.isdigit())

    total = len(words)
    if total == 0: return 0.0

    score = min(((capitalized + numbers) / total) * 5.0, 1.0)
    return score

def calculate_user_alignment_score(response: str) -> float:
    """
    Heuristic: relevance to user context fields.
    Returns score 0.0 - 1.0
    """
    # Assuming basic user context alignment
    return 0.8  # Placeholder static value for now

def detect_overcorrection(response: str, trace_content: str) -> bool:
    """
    excessive hedging or constraint repetition
    """
    hedges = ["might", "perhaps", "possibly", "it could be argued", "however"]
    count = sum(1 for h in hedges if h in response.lower())
    return count > 4

def detect_self_locking(response: str, trace_content: str) -> bool:
    """
    rigid reuse of prior phrasing or structure
    """
    if not trace_content:
        return False

    # Check if exact sentences from trace appear in response
    trace_sentences = [s.strip() for s in re.split(r'[.!?]', trace_content) if len(s.strip()) > 10]
    overlap_count = 0
    for s in trace_sentences:
        if s.lower() in response.lower():
            overlap_count += 1

    return overlap_count >= 2

def detect_aesthetic_recursion(response: str) -> bool:
    """
    response drifts into describing its own reasoning instead of answering
    """
    meta_phrases = ["my reasoning process", "as i analyze", "evaluating the constraints", "upon reflecting on r1"]
    count = sum(1 for p in meta_phrases if p in response.lower())
    return count >= 2

def score_run(run: ExperimentRun) -> ExperimentRun:
    """
    Calculates metrics and sets flags on the given run object.
    """
    # We evaluate the final output
    output_to_evaluate = run.model_output_reflected or run.model_output_initial or ""

    trace_content = ""
    if run.injected_trace and "raw" in run.injected_trace:
        trace_content = run.injected_trace["raw"]

    metrics = Metrics(
        contradiction_score=calculate_contradiction_score(output_to_evaluate, trace_content),
        drift_score=calculate_drift_score(output_to_evaluate, run.base_prompt),
        self_reference_density=calculate_self_reference_density(output_to_evaluate),
        specificity_score=calculate_specificity_score(output_to_evaluate),
        user_alignment_score=calculate_user_alignment_score(output_to_evaluate)
    )

    flags = Flags(
        overcorrection=detect_overcorrection(output_to_evaluate, trace_content),
        self_locking=detect_self_locking(output_to_evaluate, trace_content),
        aesthetic_recursion=detect_aesthetic_recursion(output_to_evaluate)
    )

    run.metrics = metrics
    run.flags = flags
    return run
