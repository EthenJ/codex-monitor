"""Build the deployment-only plugin; never include tests, CI, caches or local state."""
import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Choose a new output directory (existing files are never removed)")
    subprocess.run(["node", str(ROOT / "tools" / "build-plugin.mjs"), str(destination)], check=True)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination")
    print(build(parser.parse_args().destination))
