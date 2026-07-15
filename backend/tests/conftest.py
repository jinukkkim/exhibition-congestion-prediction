import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# app.config evaluates Settings() at import time; give collection a default
# so test modules that transitively import it don't fail on a checkout
# without a local .env file.
os.environ.setdefault("SEOUL_API_KEY", "test-key")
