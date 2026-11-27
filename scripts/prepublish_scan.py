#!/usr/bin/env python3
"""Pre-publish scanner for Claude Code extensions (skills, agents, hooks, mods).

Run it on the folder you are about to push. It reports, per file and line:
  HIGH   secrets (API keys, tokens, private keys), forbidden files, symlinks
  MEDIUM personal data (emails, user paths, names) and confidential terms
  LOW    large or binary files worth a look

Exit code: 2 if any HIGH finding, 1 if any MEDIUM, else 0. Matched values are
masked in the output. Nothing is sent anywhere.

Usage:
  python -I prepublish_scan.py PATH [PATH ...] [--terms TERMS_FILE] [--json OUT]

TERMS_FILE: one confidential term or regex per line (# comments allowed).
Keep that file OUT of the repo you publish.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path

SKIP_DIRS = {".git", "node_modules", "__pycache__", ".venv", "dist", "build"}

# (rule id, severity, regex). Patterns follow gitleaks' high-confidence rules.
SECRET_RULES = [
    ("anthropic-key", "HIGH", r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    ("openai-key", "HIGH", r"\bsk-(?:proj-)?[A-Za-z0-9_\-]{32,}"),
    ("github-token", "HIGH", r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}"),
    ("github-pat", "HIGH", r"\bgithub_pat_[A-Za-z0-9_]{50,}"),
    ("aws-access-key", "HIGH", r"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"),
    ("slack-token", "HIGH", r"\bxox[abprs]-[A-Za-z0-9\-]{10,}"),
    ("google-api-key", "HIGH", r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    ("private-key", "HIGH", r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    ("jwt", "HIGH", r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}"),
    ("bearer-literal", "HIGH", r"(?i)\bbearer\s+[A-Za-z0-9_\-\.=]{24,}"),
    # key = "long opaque value"  (assignment of a literal to a secret-ish name)
    ("generic-secret-assign", "HIGH",
     r"(?i)\b[\w\-]*(?:api[_\-]?key|secret|passw(?:or)?d|access[_\-]?token|auth[_\-]?token|client[_\-]?secret)[\w\-]*"
     r"[\"']?\s*[:=]\s*[\"']([A-Za-z0-9_\-\/+=\.]{16,})[\"']"),
]

PII_RULES = [
    ("email", "MEDIUM", r"\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b"),
    ("windows-user-path", "MEDIUM", r"(?i)\b[A-Z]:[\\/]+Users[\\/]+[^\\/\s\"']+"),
    ("posix-user-path", "MEDIUM", r"(?i)/(?:c/)?Users/[^/\s\"']+|/home/[^/\s\"']+"),
    ("onedrive-path", "MEDIUM", r"(?i)OneDrive\s*-\s*[^\\/\"'\n]+"),
]

# Emails that are fine to publish: no-reply addresses and RFC 2606 reserved domains.
EMAIL_ALLOW = re.compile(r"(?i)noreply@|no-reply@|@(?:[\w-]+\.)*example\.(?:com|org|net)$|\.(?:test|example|invalid)$|@users\.noreply\.github\.com$")
PATH_ALLOW = re.compile(r"(?i)Users[\\/]+(?:<|\$|%|\{|you\b|username\b|name\b|me\b|public\b|someone\b|user\b|example\b)")

FORBIDDEN_NAMES = re.compile(
    r"(?i)^(?:\.credentials\.json|\.env(?:\..*)?|history\.jsonl|.*\.pem|.*\.p12|.*\.pfx|id_rsa.*|id_ed25519.*|"
    r"settings\.local\.json|\.claude\.json|.*\.jsonl|stats-cache\.json|remote-settings\.json|MEMORY\.md)$")

BIG_FILE_BYTES = 1_000_000


def mask(s: str) -> str:
    s = s.strip()
    if len(s) <= 8:
        return s[:2] + "***"
    return s[:4] + "***" + s[-2:]


def load_terms(path: str | None) -> list[tuple[str, re.Pattern]]:
    if not path:
        return []
    out = []
    for raw in Path(path).read_text(encoding="utf-8").splitlines():
        t = raw.strip()
        if not t or t.startswith("#"):
            continue
        # "re:<regex>" is a regex; anything else is a literal, matched as a whole word.
        rx = t[3:] if t.startswith("re:") else r"\b" + re.escape(t) + r"\b"
        out.append((t, re.compile(rx, re.I)))
    return out


def iter_files(root: Path):
    if root.is_file() or root.is_symlink():
        yield root
        return
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        d = Path(dirpath)
        for name in dirnames:
            if (d / name).is_symlink():
                yield d / name
        for name in filenames:
            yield d / name


def is_binary(p: Path) -> bool:
    try:
        with open(p, "rb") as fh:
            return b"\0" in fh.read(4096)
    except OSError:
        return True


def scan_file(p: Path, terms) -> list[dict]:
    f = []

    def add(rule, sev, line, value=""):
        f.append({"file": str(p), "line": line, "rule": rule, "severity": sev,
                  "value": mask(value) if sev == "HIGH" else value.strip()[:80]})

    if p.is_symlink():
        add("symlink", "HIGH", 0, "-> " + os.readlink(p))
        return f
    if FORBIDDEN_NAMES.match(p.name):
        add("forbidden-file", "HIGH", 0, p.name)
    try:
        size = p.stat().st_size
    except OSError:
        return f
    if size > BIG_FILE_BYTES:
        add("large-file", "LOW", 0, f"{size/1e6:.1f} MB")
    if is_binary(p):
        add("binary-file", "LOW", 0, p.suffix or "(no ext)")
        return f
    text = p.read_text(encoding="utf-8", errors="replace")
    for i, line in enumerate(text.splitlines(), 1):
        for rule, sev, rx in SECRET_RULES:
            for m in re.finditer(rx, line):
                add(rule, sev, i, m.group(m.lastindex or 0))
        for rule, sev, rx in PII_RULES:
            for m in re.finditer(rx, line):
                v = m.group(0)
                if rule == "email" and EMAIL_ALLOW.search(v):
                    continue
                if "path" in rule and PATH_ALLOW.search(v):
                    continue
                add(rule, sev, i, v)
        for label, rx in terms:
            for m in rx.finditer(line):
                add("confidential-term", "MEDIUM", i, f"{label}: {m.group(0)}")
    return f


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("paths", nargs="+")
    ap.add_argument("--terms", help="file of confidential terms/regexes (keep it out of the repo)")
    ap.add_argument("--json", help="also write findings as JSON to this path")
    a = ap.parse_args(argv)
    terms = load_terms(a.terms)
    findings = []
    nfiles = 0
    for root in a.paths:
        for p in iter_files(Path(root)):
            nfiles += 1
            findings.extend(scan_file(p, terms))
    order = {"HIGH": 0, "MEDIUM": 1, "LOW": 2}
    findings.sort(key=lambda x: (order[x["severity"]], x["file"], x["line"]))
    for x in findings:
        print(f'{x["severity"]:6} {x["rule"]:22} {x["file"]}:{x["line"]}  {x["value"]}')
    counts = {s: sum(1 for x in findings if x["severity"] == s) for s in order}
    print(f"\nScanned {nfiles} files: HIGH={counts['HIGH']} MEDIUM={counts['MEDIUM']} LOW={counts['LOW']}")
    if a.json:
        Path(a.json).write_text(json.dumps(findings, indent=1), encoding="utf-8")
    return 2 if counts["HIGH"] else 1 if counts["MEDIUM"] else 0


if __name__ == "__main__":
    sys.exit(main())
