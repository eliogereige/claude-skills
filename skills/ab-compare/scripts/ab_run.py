"""Run one prompt twice through headless Claude Code, vanilla vs your full setup, and compare.

  vanilla : claude -p --safe-mode   (no CLAUDE.md, skills, plugins, hooks, MCP, agents, memory)
  mine    : claude -p               (everything you normally have at user level)

Both arms: same prompt, same --model, same --effort, same --permission-mode, each in its own new
empty folder, run at the same time. Writes report.html + summary.json in the output folder.

Usage:
  python ab_run.py "build a snake game" [--runs 1] [--model opus] [--effort high]
                   [--permission-mode auto] [--max-budget-usd 10] [--timeout-min 45]
                   [--out DIR] [--blind]
  python ab_run.py @prompt.txt ...            (read the prompt from a file)
"""
import argparse
import datetime as dt
import glob
import html
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import attribute  # noqa: E402

PROJECTS = os.path.expanduser("~/.claude/projects")
AUTONOMOUS_SUFFIX = ("Nobody can answer questions during this run: do not ask for clarification, make reasonable "
                     "assumptions, state them briefly, and finish the task.")
SKIP_DIRS = {"node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next"}


def slug(s, n=40):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:n] or "prompt"


def find_claude():
    exe = shutil.which("claude") or shutil.which("claude.cmd") or shutil.which("claude.exe")
    if not exe:
        sys.exit("claude CLI not found on PATH")
    return exe


def find_desktop_skills():
    """The Claude desktop app keeps the account's full skill set (incl. org-provisioned skills) here;
    a terminal `claude -p` only gets a synced subset, so we load this folder with --plugin-dir.
    Several org/account folders can exist: take the one whose manifest was refreshed last."""
    root = os.path.join(os.environ.get("APPDATA", ""), "Claude", "local-agent-mode-sessions", "skills-plugin")
    mans = glob.glob(os.path.join(root, "*", "*", "manifest.json"))
    mans = [m for m in mans if os.path.isdir(os.path.join(os.path.dirname(m), "skills"))]
    if not mans:
        return None
    return os.path.dirname(max(mans, key=os.path.getmtime))


def start_arm(exe, arm, workdir, prompt, a):
    os.makedirs(workdir, exist_ok=True)
    cmd = [exe, "-p", "--output-format", "json", "--model", a.model, "--effort", a.effort,
           "--permission-mode", a.permission_mode]
    if a.max_budget_usd:
        cmd += ["--max-budget-usd", str(a.max_budget_usd)]
    if arm == "vanilla":
        cmd.append("--safe-mode")
    elif a.desktop_skills:
        cmd += ["--plugin-dir", a.desktop_skills]
    out = open(os.path.join(os.path.dirname(workdir), arm + ".result.json"), "w", encoding="utf8")
    err = open(os.path.join(os.path.dirname(workdir), arm + ".stderr.txt"), "w", encoding="utf8")
    env = dict(os.environ)
    p = subprocess.Popen(cmd, cwd=workdir, stdin=subprocess.PIPE, stdout=out, stderr=err, env=env,
                         text=True, encoding="utf8")
    p.stdin.write(prompt)
    p.stdin.close()
    return {"arm": arm, "proc": p, "cmd": cmd, "workdir": workdir, "t0": time.time(), "out": out, "err": err}


def find_transcript(session_id):
    hits = glob.glob(os.path.join(PROJECTS, "*", session_id + ".jsonl"))
    return hits[0] if hits else None


def list_files(root):
    files = []
    for dp, dns, fns in os.walk(root):
        dns[:] = [d for d in dns if d not in SKIP_DIRS]
        for f in fns:
            fp = os.path.join(dp, f)
            files.append((os.path.relpath(fp, root).replace("\\", "/"), os.path.getsize(fp)))
    return sorted(files)


def pick_entry_html(files):
    htmls = [f for f, _ in files if f.lower().endswith(".html")]
    for pref in ("index.html",):
        for f in htmls:
            if f.lower().endswith(pref) and f.count("/") == 0:
                return f
    return sorted(htmls, key=lambda f: (f.count("/"), len(f)))[0] if htmls else None


def fmt_money(x):
    return "n/a" if x is None else f"${x:,.3f}"


def fmt_int(x):
    return "n/a" if x is None else f"{x:,.0f}"


def summarize(res):
    if not res:
        return {}
    mu = res.get("modelUsage") or {}
    tin = sum((m.get("inputTokens") or 0) for m in mu.values())
    tout = sum((m.get("outputTokens") or 0) for m in mu.values())
    tcr = sum((m.get("cacheReadInputTokens") or 0) for m in mu.values())
    tcw = sum((m.get("cacheCreationInputTokens") or 0) for m in mu.values())
    think = sum((m.get("thinkingTokens") or 0) for m in mu.values())
    sub = res.get("subagent_stats") or {}
    return {"cost_usd": res.get("total_cost_usd"), "input_uncached": tin, "cache_read": tcr, "cache_write": tcw,
            "output": tout, "thinking": think, "total_tokens": tin + tout + tcr + tcw,
            "turns": res.get("num_turns"), "duration_s": (res.get("duration_ms") or 0) / 1000,
            "is_error": res.get("is_error"), "subtype": res.get("subtype"), "stop": res.get("terminal_reason"),
            "permission_denials": len(res.get("permission_denials") or []),
            "subagents_spawned": sub.get("spawned"), "models": list(mu.keys())}


def run(a):
    prompt = open(a.prompt[1:], encoding="utf8").read() if a.prompt.startswith("@") else a.prompt
    if a.autonomous:  # same sentence for both arms, so the comparison stays fair
        prompt = prompt.rstrip() + "\n\n" + AUTONOMOUS_SUFFIX
    exe = find_claude()
    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    out = os.path.abspath(a.out or os.path.join(os.path.expanduser("~/ab-runs"), f"{stamp}-{slug(prompt)}"))
    os.makedirs(out, exist_ok=True)
    open(os.path.join(out, "prompt.txt"), "w", encoding="utf8").write(prompt)
    if a.desktop_skills == "auto":
        a.desktop_skills = find_desktop_skills()
    elif a.desktop_skills == "none":
        a.desktop_skills = None
    settings = {"desktop_skills_dir (your setup only)": a.desktop_skills,
                "model": a.model, "effort": a.effort, "permission_mode": a.permission_mode,
                "max_budget_usd_per_arm": a.max_budget_usd, "timeout_min": a.timeout_min, "runs": a.runs,
                "claude_version": subprocess.run([exe, "--version"], capture_output=True, text=True).stdout.strip()}
    print(f"[ab] output folder: {out}")
    print(f"[ab] settings: {settings}")
    runs = []
    for i in range(1, a.runs + 1):
        rdir = os.path.join(out, f"run{i}")
        arms = [start_arm(exe, arm, os.path.join(rdir, arm, "work"), prompt, a) for arm in ("vanilla", "mine")]
        print(f"[ab] run {i}/{a.runs}: both arms started")
        deadline = time.time() + a.timeout_min * 60
        for st in arms:
            try:
                st["proc"].wait(timeout=max(1, deadline - time.time()))
                st["timed_out"] = False
            except subprocess.TimeoutExpired:
                st["proc"].kill()
                st["timed_out"] = True
            st["wall_s"] = time.time() - st["t0"]
            st["out"].close()
            st["err"].close()
            print(f"[ab] run {i} {st['arm']}: exit {st['proc'].returncode} after {st['wall_s']:.0f}s"
                  + (" (TIMED OUT)" if st["timed_out"] else ""))
        rec = {"run": i, "arms": {}}
        for st in arms:
            arm = st["arm"]
            rpath = os.path.join(rdir, arm, arm + ".result.json")
            res = None
            try:
                res = json.load(open(rpath, encoding="utf8"))
            except Exception as e:
                print(f"[ab] {arm}: no parsable result ({e}); see {arm}.stderr.txt")
            tr = find_transcript(res["session_id"]) if res and res.get("session_id") else None
            rec["arms"][arm] = {"result": res, "summary": summarize(res), "transcript": tr,
                                "workdir": st["workdir"], "files": list_files(st["workdir"]),
                                "exit": st["proc"].returncode, "timed_out": st["timed_out"], "wall_s": st["wall_s"],
                                "cmd": " ".join(c if " " not in c else f'"{c}"' for c in st["cmd"][1:])}
        # attribution: vanilla first, then mine against it
        base = None
        for arm in ("vanilla", "mine"):
            A = rec["arms"][arm]
            if A["transcript"]:
                try:
                    A["attribution"] = attribute.finalize(A["transcript"], A["result"], base, vanilla=(arm == "vanilla"))
                    if arm == "vanilla":
                        base = A["attribution"]
                except Exception as e:  # report, never hide
                    A["attribution_error"] = repr(e)
                    print(f"[ab] attribution failed for {arm}: {e!r}")
            else:
                A["attribution_error"] = "transcript not found"
        runs.append(rec)
    labels = {"vanilla": "Vanilla (safe mode)", "mine": "Your setup"}
    key = None
    if a.blind:
        order = ["vanilla", "mine"]
        random.shuffle(order)
        labels = {order[0]: "Arm A", order[1]: "Arm B"}
        key = {labels[k]: k for k in order}
        open(os.path.join(out, "BLIND-KEY.json"), "w", encoding="utf8").write(json.dumps(key, indent=1))
    summary = {"prompt": prompt, "settings": settings, "out": out, "blind": a.blind,
               "runs": [{"run": r["run"], "arms": {k: {kk: vv for kk, vv in v.items() if kk not in ("result",)}
                                                     for k, v in r["arms"].items()}} for r in runs]}
    json.dump(summary, open(os.path.join(out, "summary.json"), "w", encoding="utf8"), indent=1, default=str)
    write_report(out, prompt, settings, runs, labels, a.blind)
    print(f"[ab] report: {os.path.join(out, 'report.html')}")
    for r in runs:
        for arm in ("vanilla", "mine"):
            s = r["arms"][arm]["summary"]
            print(f"[ab] run {r['run']} {labels[arm]:>20}: cost {fmt_money(s.get('cost_usd'))}  tokens {fmt_int(s.get('total_tokens'))}"
                  f"  out {fmt_int(s.get('output'))}  turns {s.get('turns')}  {s.get('duration_s', 0):.0f}s")
    return out


# ------------------------------------------------------------------------------- report
CSS = """
:root{--bg:#fbfaf7;--fg:#1d1c1a;--mut:#6b6862;--line:#e3e0d8;--card:#fff;--a:#2f6f5e;--b:#8a4b2a;--bar:#d9d4c7}
@media (prefers-color-scheme:dark){:root{--bg:#171614;--fg:#ece9e2;--mut:#a39f96;--line:#33312c;--card:#1f1e1b;--a:#6fbfa6;--b:#e0a07a;--bar:#3a3833}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:1400px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:32px 0 10px}
h3{font-size:15px;margin:18px 0 8px}.mut{color:var(--mut)}code,pre{font:12.5px/1.45 ui-monospace,Consolas,monospace}
pre{white-space:pre-wrap;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px;max-height:340px;overflow:auto}
table{border-collapse:collapse;width:100%;background:var(--card);border:1px solid var(--line);border-radius:8px;overflow:hidden}
th,td{padding:6px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}th{font-weight:600;color:var(--mut);font-size:12.5px}
td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media (max-width:900px){.grid{grid-template-columns:1fr}}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}
iframe{width:100%;height:560px;border:1px solid var(--line);border-radius:8px;background:#fff}
.bar{height:8px;background:var(--bar);border-radius:4px;overflow:hidden;min-width:60px}.bar>i{display:block;height:100%;background:var(--a)}
.tag{display:inline-block;padding:1px 7px;border-radius:10px;border:1px solid var(--line);font-size:12px;color:var(--mut)}
details summary{cursor:pointer;color:var(--mut);margin:6px 0}.delta-up{color:var(--b)}.delta-dn{color:var(--a)}
"""


def esc(x):
    return html.escape(str(x))


def rel(out, p):
    return os.path.relpath(p, out).replace("\\", "/")


def attribution_tables(att, label):
    if not att:
        return "<p class='mut'>No attribution available.</p>"
    hascost = att.get("total_cost_attributed") is not None
    rows = []
    for o in att["owners"]:
        pct = o["cost_pct"] if hascost else o["token_pct"]
        rows.append(f"<tr><td>{esc(o['owner'])}</td><td class=n>{fmt_int(o['tokens'])}</td><td class=n>{o['token_pct']:.1f}%</td>"
                    f"<td class=n>{fmt_money(o['cost_usd']) if hascost else 'n/a'}</td>"
                    f"<td class=n>{(str(round(o['cost_pct'], 1)) + '%') if o['cost_pct'] is not None else 'n/a'}</td>"
                    f"<td><div class=bar><i style='width:{min(100, pct):.1f}%'></i></div></td></tr>")
    det = []
    for r in att["rows"][:60]:
        det.append(f"<tr><td>{esc(r['category'])}</td><td>{esc(r['name'])}</td><td>{esc(r['owner'])}</td>"
                   f"<td class=n>{fmt_int(r['tokens'])}</td><td class=n>{r['token_pct']:.1f}%</td>"
                   f"<td class=n>{fmt_money(r.get('cost_usd'))}</td>"
                   f"<td class=n>{(str(round(r['cost_pct'], 1)) + '%') if r.get('cost_pct') is not None else 'n/a'}</td></tr>")
    cpt = att.get("chars_per_token_range")
    q = (f"{att['requests']} API requests rebuilt from the transcript; "
         f"{att.get('messages_unresolved', '?')} of {att.get('messages_total', '?')} referenced messages could not be matched "
         f"(their share is spread over the rest of that request); implied chars/token {cpt[0]}–{cpt[1]}." if cpt else "")
    return (f"<h3>{esc(label)}: who used the tokens</h3><table><tr><th>Source</th><th>Tokens</th><th>% tokens</th><th>Cost</th>"
            f"<th>% cost</th><th></th></tr>{''.join(rows)}</table><p class=mut>{esc(q)}</p>"
            f"<details><summary>Item-level detail (top 60 by cost)</summary><table><tr><th>Kind</th><th>Item</th><th>Source</th>"
            f"<th>Tokens</th><th>% tok</th><th>Cost</th><th>% cost</th></tr>{''.join(det)}</table></details>")


def write_report(out, prompt, settings, runs, labels, blind):
    order = ["vanilla", "mine"]
    if blind:
        order = sorted(order, key=lambda k: labels[k])
    parts = [f"<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
             f"<title>A/B skill check</title><style>{CSS}</style></head><body><main>",
             f"<h1>A/B check: vanilla Claude Code vs your setup</h1><p class=mut>Prompt below · model <code>{esc(settings['model'])}</code>"
             f" · effort <code>{esc(settings['effort'])}</code> · permissions <code>{esc(settings['permission_mode'])}</code>"
             f" · budget per arm {esc(settings['max_budget_usd_per_arm'] or 'none')} USD · {esc(settings['claude_version'])}"
             + (" · <b>blind labels</b> (key in BLIND-KEY.json)" if blind else "")
             + f" · your setup also loads desktop account skills: <code>{esc(settings.get('desktop_skills_dir (your setup only)') or 'no')}</code></p>",
             f"<pre>{esc(prompt)}</pre>"]
    for r in runs:
        A = r["arms"]
        parts.append(f"<h2>Run {r['run']}</h2>")
        # metrics table
        metrics = [("Cost", "cost_usd", fmt_money), ("Total tokens processed", "total_tokens", fmt_int),
                   ("  cache reads", "cache_read", fmt_int), ("  cache writes", "cache_write", fmt_int),
                   ("  uncached input", "input_uncached", fmt_int), ("Output tokens", "output", fmt_int),
                   ("  of which thinking", "thinking", fmt_int), ("Turns (last turn only if it ran in the background)", "turns", fmt_int),
                   ("Wall time (s)", "wall_s", fmt_int), ("Subagents spawned", "subagents_spawned", fmt_int),
                   ("Permission denials", "permission_denials", fmt_int)]
        hdr = "".join(f"<th>{esc(labels[k])}</th>" for k in order)
        trs = []
        for name, key, f in metrics:
            vals = [A[k].get("wall_s") if key == "wall_s" else A[k]["summary"].get(key) for k in order]
            cells = "".join(f"<td class=n>{f(v)}</td>" for v in vals)
            ratio = ""
            if all(isinstance(v, (int, float)) and v for v in vals) and not blind:
                ratio = f"{vals[1] / vals[0]:.2f}×"
            trs.append(f"<tr><td>{esc(name)}</td>{cells}<td class=n>{ratio}</td></tr>")
        status = "".join(f"<td>{esc(A[k]['summary'].get('subtype'))}{' · TIMED OUT' if A[k]['timed_out'] else ''}"
                         f"{' · error' if A[k]['summary'].get('is_error') else ''}</td>" for k in order)
        parts.append(f"<table><tr><th>Metric</th>{hdr}<th>{'' if blind else 'yours ÷ vanilla'}</th></tr>{''.join(trs)}"
                     f"<tr><td>Status</td>{status}<td></td></tr></table>")
        # outputs side by side
        parts.append("<div class=grid>")
        for k in order:
            X = A[k]
            entry = pick_entry_html(X["files"])
            videos = [f for f, _ in X["files"] if f.lower().endswith((".mp4", ".webm", ".mov"))]
            vid = "".join(f"<video controls preload=metadata style='width:100%;border-radius:8px' src='{esc(rel(out, os.path.join(X['workdir'], v)))}'></video>"
                          f"<p class=mut>Video: <code>{esc(v)}</code></p>" for v in videos[:3])
            files = "".join(f"<li><a href='{esc(rel(out, os.path.join(X['workdir'], f)))}'>{esc(f)}</a> <span class=mut>{s:,} B</span></li>"
                            for f, s in X["files"][:80])
            more = f"<li class=mut>… {len(X['files']) - 80} more</li>" if len(X["files"]) > 80 else ""
            frame = (f"<iframe sandbox='allow-scripts' src='{esc(rel(out, os.path.join(X['workdir'], entry)))}'></iframe>"
                     f"<p class=mut>Showing <code>{esc(entry)}</code>. <a target=_blank href='{esc(rel(out, os.path.join(X['workdir'], entry)))}'>Open full page</a></p>") if entry else ("" if vid else "<p class=mut>No HTML or video output to preview.</p>")
            frame = vid + frame
            answer = (X["result"] or {}).get("result", "") if X["result"] else "(no result)"
            parts.append(f"<div class=card><h3>{esc(labels[k])}</h3>{frame}<details open><summary>Files ({len(X['files'])})</summary><ul>{files}{more}</ul></details>"
                         f"<details><summary>Final message</summary><pre>{esc(answer)}</pre></details>"
                         f"<details><summary>Command</summary><pre>claude {esc(X['cmd'])}</pre></details></div>")
        parts.append("</div>")
        # attribution
        if not blind:
            parts.append("<h2>Where the tokens went</h2><p class=mut>Every API call is rebuilt from the run's transcript; each piece "
                         "(tool definitions, system-prompt sections, CLAUDE.md, skill list, hook output, MCP instructions, tool results, "
                         "model output) gets its share of that call's exact token counts. Cost uses Anthropic's price ratios (cache read 0.1×, "
                         "cache write 1.25×/2×, output 5× input), scaled to the exact cost Claude Code reported. Item sizes are estimates "
                         "within each call; call totals are exact.</p>")
            parts.append(attribution_tables(A["mine"].get("attribution"), labels["mine"]))
            if A["mine"].get("attribution_error"):
                parts.append(f"<p class=mut>Attribution error: {esc(A['mine']['attribution_error'])}</p>")
            parts.append("<details><summary>Same breakdown for the vanilla run</summary>"
                         + attribution_tables(A["vanilla"].get("attribution"), labels["vanilla"]) + "</details>")
        else:
            parts.append("<p class=mut>Token attribution hidden in blind mode (it would reveal which arm is which). "
                         "Re-render without --blind after grading: <code>python ab_run.py --rerender &lt;folder&gt;</code></p>")
        parts.append("<h3>Your verdict</h3><p class=mut>Grade each arm on what matters for this task (works? complete? quality? "
                     "followed the prompt?) before looking at cost, and note it in verdict.md in this folder.</p>")
    parts.append("</main></body></html>")
    open(os.path.join(out, "report.html"), "w", encoding="utf8").write("".join(parts))


def rerender(folder):
    s = json.load(open(os.path.join(folder, "summary.json"), encoding="utf8"))
    runs = []
    for r in s["runs"]:
        for arm, v in r["arms"].items():
            try:
                v["result"] = json.load(open(os.path.join(folder, f"run{r['run']}", arm, arm + ".result.json"), encoding="utf8"))
            except Exception:
                v["result"] = None
            v["files"] = [tuple(x) for x in v["files"]]
        base = None  # recompute attribution so analyzer fixes apply to old runs too
        for arm in ("vanilla", "mine"):
            v = r["arms"][arm]
            if v.get("transcript") and os.path.exists(v["transcript"]):
                v["attribution"] = attribute.finalize(v["transcript"], v["result"], base, vanilla=(arm == "vanilla"))
                if arm == "vanilla":
                    base = v["attribution"]
        runs.append(r)
    write_report(folder, s["prompt"], s["settings"], runs, {"vanilla": "Vanilla (safe mode)", "mine": "Your setup"}, False)
    print(os.path.join(folder, "report.html"))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("prompt", nargs="?", help="the task prompt, or @file")
    ap.add_argument("--runs", type=int, default=1)
    ap.add_argument("--model", default="opus")
    ap.add_argument("--effort", default="high", choices=["low", "medium", "high", "xhigh", "max"])
    ap.add_argument("--permission-mode", default="auto",
                    choices=["acceptEdits", "auto", "bypassPermissions", "dontAsk", "manual", "plan"])
    ap.add_argument("--max-budget-usd", type=float, default=10.0, help="per arm per run; 0 = no cap")
    ap.add_argument("--timeout-min", type=float, default=45)
    ap.add_argument("--out")
    ap.add_argument("--blind", action="store_true", help="label arms A/B at random; key saved to BLIND-KEY.json")
    ap.add_argument("--desktop-skills", default="auto", metavar="auto|none|DIR",
                    help="your-setup arm only: load the desktop app's account skills folder (org skills such as "
                         "acme-brand) with --plugin-dir; 'auto' finds it, 'none' skips it")
    ap.add_argument("--autonomous", action="store_true",
                    help="append one 'no questions, make assumptions' sentence to the prompt of BOTH arms")
    ap.add_argument("--rerender", metavar="FOLDER", help="rebuild report.html (unblinded) from an existing run folder")
    a = ap.parse_args()
    if a.rerender:
        return rerender(a.rerender)
    if not a.prompt:
        ap.error("prompt required")
    run(a)


if __name__ == "__main__":
    main()
