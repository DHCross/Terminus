"""
Code Interpreter & Execution Engine for Terminus (OpenClaw Pillar 2).

Provides full native Python code execution and shell automation:
  - Arbitrary Python script execution with data science stack (numpy, pandas, matplotlib, requests)
  - Automatic chart capture: any matplotlib figures created are auto-saved to ~/.terminus/data/charts/
  - System shell execution (bash / zsh) for developer workflows, CLI automation, and tasks
"""

import logging
import os
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, Optional

logger = logging.getLogger(__name__)

# Base output directories
CHARTS_DIR = Path.home() / ".terminus" / "data" / "charts"
OUTPUTS_DIR = Path.home() / ".terminus" / "data" / "code_outputs"
CHARTS_DIR.mkdir(parents=True, exist_ok=True)
OUTPUTS_DIR.mkdir(parents=True, exist_ok=True)

# Venv python executable
VENV_PYTHON = Path(__file__).parent.parent / "venv" / "bin" / "python"
if not VENV_PYTHON.exists():
    VENV_PYTHON = Path(sys.executable)


class CodeInterpreter:
    """Executes Python code and shell commands natively on macOS."""

    def __init__(self):
        self.charts_dir = CHARTS_DIR
        self.outputs_dir = OUTPUTS_DIR
        self.python_bin = str(VENV_PYTHON)

    def python_execute(self, code: str, timeout: int = 30) -> str:
        """
        Execute arbitrary Python code in the Terminus virtual environment.
        Automatically captures stdout, stderr, and any matplotlib plots.
        """
        if not code.strip():
            return "No Python code provided to execute."

        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        chart_path = self.charts_dir / f"chart_{timestamp}.png"

        # Wrapper script that executes code and auto-saves open matplotlib figures
        wrapper_code = f"""
import sys
import io

# Setup auto-chart export if matplotlib is used
_chart_saved = False
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    _has_plt = True
except ImportError:
    _has_plt = False

# Execute user code in clean global namespace
_globals = {{'__name__': '__main__'}}
try:
{_indent_code(code, 4)}
except Exception as e:
    import traceback
    traceback.print_exc()

# Check if matplotlib has active figures to save
if _has_plt and len(plt.get_fignums()) > 0:
    plt.savefig(r"{chart_path}", bbox_inches='tight', dpi=150)
    plt.close('all')
    print(f"\\n[CHART_SAVED]: {chart_path}")
"""

        with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
            f.write(wrapper_code)
            temp_script = f.name

        try:
            result = subprocess.run(
                [self.python_bin, temp_script],
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=str(Path.home()),
            )

            stdout = result.stdout.strip()
            stderr = result.stderr.strip()

            output_lines = []
            if stdout:
                output_lines.append(stdout)
            if stderr:
                output_lines.append(f"[stderr]:\n{stderr}")
            if not stdout and not stderr:
                output_lines.append("(Code executed successfully with no printed output)")

            final_output = "\n".join(output_lines)
            if len(final_output) > 6000:
                final_output = final_output[:6000] + f"\n\n[... {len(final_output) - 6000} chars truncated]"

            return final_output
        except subprocess.TimeoutExpired:
            return f"Python execution timed out after {timeout} seconds."
        except Exception as e:
            logger.error("Python execution failed: %s", e)
            return f"Failed to execute Python code: {e}"
        finally:
            try:
                os.remove(temp_script)
            except Exception:
                pass

    def bash_execute(self, command: str, timeout: int = 60, cwd: Optional[str] = None) -> str:
        """
        Execute arbitrary bash/zsh shell commands on macOS.
        """
        if not command.strip():
            return "No command provided."

        work_dir = cwd or str(Path.home())
        try:
            result = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                timeout=timeout,
                cwd=work_dir,
                executable="/bin/zsh",
            )

            stdout = result.stdout.strip()
            stderr = result.stderr.strip()

            output_lines = []
            if stdout:
                output_lines.append(stdout)
            if stderr:
                output_lines.append(f"[stderr]:\n{stderr}")
            if not stdout and not stderr:
                output_lines.append("(Command completed successfully with no output)")

            final_output = "\n".join(output_lines)
            if len(final_output) > 6000:
                final_output = final_output[:6000] + f"\n\n[... {len(final_output) - 6000} chars truncated]"

            return final_output
        except subprocess.TimeoutExpired:
            return f"Command timed out after {timeout} seconds."
        except Exception as e:
            logger.error("Bash execution failed: %s", e)
            return f"Command execution failed: {e}"


def _indent_code(code: str, spaces: int = 4) -> str:
    """Indent code lines for execution inside wrapper try-block."""
    indent = " " * spaces
    return "\n".join(indent + line for line in code.splitlines())


# Global singleton instance
code_interpreter = CodeInterpreter()
