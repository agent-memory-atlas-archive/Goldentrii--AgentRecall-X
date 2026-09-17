"""
Shared helper: load the hyphenated harness-kit scripts as importable modules.

The scripts live at experimental/harness-kit/scripts/ar-*.py — hyphens in the
filename mean they cannot be `import`ed normally, so we load them by file path.
"""

import importlib.util
import sys
from pathlib import Path

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"


def load_module(module_name: str, filename: str):
    """Load a script file as a fresh module object under module_name."""
    path = SCRIPTS_DIR / filename
    spec = importlib.util.spec_from_file_location(module_name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module
