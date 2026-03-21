from typing import List, Optional, Dict, Any
from pydantic import BaseModel, Field
from datetime import datetime
import json
import os

class Metrics(BaseModel):
    contradiction_score: float = 0.0
    drift_score: float = 0.0
    self_reference_density: float = 0.0
    specificity_score: float = 0.0
    user_alignment_score: float = 0.0

class Flags(BaseModel):
    overcorrection: bool = False
    self_locking: bool = False
    aesthetic_recursion: bool = False

class ReasoningMirror(BaseModel):
    assumptions: List[str] = Field(default_factory=list)
    constraints: List[str] = Field(default_factory=list)
    uncertainties: List[str] = Field(default_factory=list)
    decision_points: List[str] = Field(default_factory=list)

class ExperimentRun(BaseModel):
    id: str
    timestamp: datetime = Field(default_factory=datetime.utcnow)
    base_prompt: str
    condition: str  # A, B, C, D, E
    injected_trace: Optional[Dict[str, Any]] = None  # raw or structured
    model_output_initial: Optional[str] = None
    model_output_reflected: Optional[str] = None
    metrics: Metrics = Field(default_factory=Metrics)
    flags: Flags = Field(default_factory=Flags)

class RunLogger:
    def __init__(self, log_dir: str = "runs"):
        self.log_dir = log_dir
        os.makedirs(self.log_dir, exist_ok=True)

    def log_run(self, run: ExperimentRun):
        filepath = os.path.join(self.log_dir, f"{run.id}.json")
        with open(filepath, 'w') as f:
            json.dump(run.model_dump(mode='json'), f, indent=2)
