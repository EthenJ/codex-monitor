#!/usr/bin/env python3
"""Minimal dependency-free validator for SKILL.md frontmatter and layout."""

from __future__ import annotations

import re
import sys
from pathlib import Path

ALLOWED_KEYS = {"name", "description", "license", "allowed-tools", "metadata"}
MAX_NAME = 64
MAX_DESCRIPTION = 1024


def validate(skill: Path) -> list[str]:
    errors: list[str] = []
    skill_md = skill / "SKILL.md"
    if not skill_md.is_file():
        return [f"missing {skill_md}"]

    text = skill_md.read_text(encoding="utf-8")
    match = re.match(r"^---\n(.*?)\n---\n", text, re.DOTALL)
    if not match:
        return ["SKILL.md must start with a --- frontmatter block"]

    keys: dict[str, str] = {}
    for line in match.group(1).splitlines():
        if not line.strip() or line.startswith((" ", "\t", "#")):
            continue
        key, _, value = line.partition(":")
        keys[key.strip()] = value.strip()

    unexpected = set(keys) - ALLOWED_KEYS
    if unexpected:
        errors.append(f"unexpected frontmatter keys: {', '.join(sorted(unexpected))}")

    name = keys.get("name", "").strip("\"'")
    if not name:
        errors.append("frontmatter is missing 'name'")
    elif not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name):
        errors.append(f"name '{name}' must be lowercase hyphen-case")
    elif len(name) > MAX_NAME:
        errors.append(f"name is longer than {MAX_NAME} characters")

    description = keys.get("description", "").strip("\"'")
    if not description:
        errors.append("frontmatter is missing 'description'")
    elif "<" in description or ">" in description:
        errors.append("description must not contain angle brackets")
    elif len(description) > MAX_DESCRIPTION:
        errors.append(f"description is longer than {MAX_DESCRIPTION} characters")

    body = text[match.end():]
    if "[TODO:" in body:
        errors.append("SKILL.md still contains a TODO placeholder")

    for reference in re.findall(r"\]\(([^)#][^)]*)\)", body):
        if reference.startswith("http"):
            continue
        if not (skill / reference).exists():
            errors.append(f"broken relative link: {reference}")

    if skill.name != name:
        errors.append(f"directory name '{skill.name}' must match skill name '{name}'")

    return errors


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python tools/validate_skill.py <skill-directory>", file=sys.stderr)
        return 2
    problems = validate(Path(argv[1]))
    if problems:
        for problem in problems:
            print(f"error: {problem}", file=sys.stderr)
        return 1
    print("Skill is valid!")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
