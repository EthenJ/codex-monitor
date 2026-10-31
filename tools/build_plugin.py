"""Build the deployment-only plugin; never include tests, CI, caches or local state."""
import argparse
import shutil
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def build(destination):
    destination = Path(destination).resolve()
    if destination.exists():
        raise ValueError("Choose a new output directory (existing files are never removed)")
    destination.mkdir(parents=True)
    for name in ("LICENSE", "README.md", "pyproject.toml", ".mcp.json", ".codex-plugin/plugin.json",
                 ".agents/plugins/marketplace.json"):
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, target)
    for source in (ROOT / "codex-monitor").rglob("*"):
        if source.is_file() and source.suffix in {".py", ".md", ".yaml"} and "__pycache__" not in source.parts:
            target = destination / source.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    return destination


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("destination")
    print(build(parser.parse_args().destination))
