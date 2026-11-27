"""Known-answer tests for prepublish_scan.py. All secrets below are synthetic.

Run: python -I -m pytest test_prepublish_scan.py   (or: python -I test_prepublish_scan.py)
"""
import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepublish_scan as ps  # noqa: E402

FAKE = {
    "anthropic-key": "sk-ant-api03-" + "A" * 40,
    "github-token": "ghp_" + "b" * 36,
    "aws-access-key": "AKIA" + "Q" * 16,
    "private-key": "-----BEGIN RSA " + "PRIVATE KEY-----",
    "generic-secret-assign": 'client_secret = "' + "x9" * 12 + '"',
}


def _scan_text(text, name="f.md", terms=None):
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / name
        p.write_text(text, encoding="utf-8")
        return ps.scan_file(p, terms or [])


def test_each_secret_rule_fires():
    for rule, value in FAKE.items():
        rules = {x["rule"] for x in _scan_text(f"line\n{value}\n")}
        assert rule in rules, (rule, rules)


def test_secret_values_are_masked():
    out = _scan_text(FAKE["github-token"])
    assert all("b" * 20 not in x["value"] for x in out)


def test_clean_text_has_no_findings():
    clean = "Use the token budget wisely.\nSet api_key from env: os.environ['API_KEY']\nnoreply@anthropic.com\n"
    assert _scan_text(clean) == []


def test_pii_and_allowlist():
    out = _scan_text("me: jane.doe@corp.io\npath C:\\Users\\JDOE\\x\nok C:\\Users\\<you>\\x\n")
    rules = [x["rule"] for x in out]
    assert rules.count("email") == 1 and rules.count("windows-user-path") == 1


def test_confidential_terms_literal_and_regex():
    with tempfile.TemporaryDirectory() as d:
        tf = Path(d) / "terms.txt"
        tf.write_text("# comment\nAcmeBio\nre:batch-\\d{4}\n", encoding="utf-8")
        terms = ps.load_terms(str(tf))
    out = _scan_text("AcmeBio data, batch-2031, acmebiology is fine\n", terms=terms)
    vals = sorted(x["value"] for x in out)
    assert len(out) == 2, vals  # whole-word literal must not hit "acmebiology"


def test_forbidden_file_name():
    out = _scan_text("{}", name=".credentials.json")
    assert any(x["rule"] == "forbidden-file" and x["severity"] == "HIGH" for x in out)


def test_exit_codes():
    with tempfile.TemporaryDirectory() as d:
        (Path(d) / "a.md").write_text("hello\n", encoding="utf-8")
        assert ps.main([d]) == 0
        (Path(d) / "b.md").write_text("x@y.org\n", encoding="utf-8")
        assert ps.main([d]) == 1
        (Path(d) / "c.md").write_text(FAKE["aws-access-key"], encoding="utf-8")
        assert ps.main([d]) == 2


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            try:
                fn(); print("PASS", name)
            except AssertionError as e:
                fails += 1; print("FAIL", name, e)
    sys.exit(1 if fails else 0)
