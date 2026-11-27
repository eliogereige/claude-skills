"""Attribute a Claude Code session's tokens and cost to the things that used them.

Rebuilds every API request from the session transcript (api-request-shape / api-request-blob /
api-request records), labels each piece of the prompt (tool definitions, system-prompt sections,
CLAUDE.md files, skill listings, hook output, MCP instructions, tool results, model output) and
splits each request's EXACT usage numbers across those pieces.

Method (stated so the numbers can be checked):
- Piece sizes are estimated from characters, then scaled per request so they sum to that request's
  exact input tokens (input + cache_read + cache_creation). Output tokens: thinking_tokens go to
  "thinking", the rest is split by characters across the response's text and tool calls.
- Prompt caching is a prefix: in API order (tools, system, messages) the first cache_read tokens are
  billed as reads, the next cache_creation tokens as writes, the rest as uncached input.
- Cost weights relative to the model's base input price: cache read 0.1, cache write 5m 1.25,
  cache write 1h 2.0, uncached input 1.0, output 5.0 (Anthropic's published price ratios).
  Weighted units are then scaled per model to the exact costUSD Claude Code reported for the run.
- Subagent transcripts (session/subagents/*.jsonl) are analysed the same way and charged, whole, to
  "subagent: <type>".

Usage: python attribute.py <session.jsonl> [--result result.json] [--baseline other_attr.json]
                           [--json out.json]
"""
import argparse
import glob
import hashlib
import json
import os
import re
import sys
from collections import defaultdict

W_READ, W_WRITE5, W_WRITE1H, W_UNCACHED, W_OUT = 0.1, 1.25, 2.0, 1.0, 5.0
CHARS_PER_TOKEN = 3.6  # only sets the pre-scaling size; every request is rescaled to exact totals


def load(path):
    rows = []
    with open(path, encoding="utf8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return rows


# ---------------------------------------------------------------- plugin / hook ownership
def plugin_hook_commands():
    """Map hook command strings to the plugin whose hooks.json declares them."""
    owners = defaultdict(set)
    root = os.path.expanduser("~/.claude/plugins")
    for hj in glob.glob(os.path.join(root, "**", "hooks", "hooks.json"), recursive=True):
        parts = os.path.normpath(hj).split(os.sep)
        try:
            i = parts.index("hooks")
            plugin = parts[i - 1]
            # cache/<marketplace>/<plugin>/<version>/hooks/hooks.json -> plugin dir is before version
            if re.match(r"^\d+(\.\d+)*", plugin) and i >= 2:
                plugin = parts[i - 2]
        except ValueError:
            continue
        try:
            data = json.load(open(hj, encoding="utf8"))
        except Exception:
            continue
        for ev in (data.get("hooks") or {}).values():
            for grp in ev or []:
                for h in grp.get("hooks", []):
                    if h.get("command"):
                        owners[h["command"].strip()].add(plugin)
    return owners


def settings_hook_commands():
    out = set()
    p = os.path.expanduser("~/.claude/settings.json")
    try:
        data = json.load(open(p, encoding="utf8"))
        for ev in (data.get("hooks") or {}).values():
            for grp in ev or []:
                for h in grp.get("hooks", []):
                    if h.get("command"):
                        out.add(h["command"].strip())
    except Exception:
        pass
    return out


HOOK_OWNERS = plugin_hook_commands()
SETTINGS_HOOKS = settings_hook_commands()


def hook_owner(command):
    if not command:
        return "hook (unknown source)"
    c = command.strip()
    if c in HOOK_OWNERS and len(HOOK_OWNERS[c]) == 1:
        return "plugin: " + next(iter(HOOK_OWNERS[c]))
    if c in SETTINGS_HOOKS:
        return "your settings.json hooks"
    m = re.search(r"[\\/]hooks[\\/]([\w.-]+)", c)
    if m:
        return "hook: " + m.group(1)
    return "hook: " + c[:40]


# ---------------------------------------------------------------- piece labelling
def split_skill_listing(text):
    pieces, cur, cur_name = [], [], None
    for line in text.splitlines(keepends=True):
        m = re.match(r"^- ([\w:./-]+)(?: \([^)]*\))?:", line)
        if m:
            if cur:
                pieces.append((cur_name, "".join(cur)))
            cur, cur_name = [line], m.group(1)
        else:
            cur.append(line)
    if cur:
        pieces.append((cur_name, "".join(cur)))
    out = []
    for name, chunk in pieces:
        if name is None:
            out.append(("skill listing", "(header)", "Claude Code built-in", chunk))
        else:
            owner = ("plugin: " + name.split(":")[0]) if ":" in name else None
            out.append(("skill listing", name, owner, chunk))
    return out


def split_by(text, marker_re, category, owner_fn):
    idx = [m.start() for m in re.finditer(marker_re, text, flags=re.M)]
    if not idx:
        return [(category, "(all)", owner_fn(None), text)]
    out = []
    if idx[0] > 0:
        out.append((category, "(header)", "Claude Code built-in", text[: idx[0]]))
    for a, b in zip(idx, idx[1:] + [len(text)]):
        chunk = text[a:b]
        name = re.match(marker_re, chunk, flags=re.M)
        nm = (name.group(1) if name and name.groups() else chunk[:40]).strip()
        out.append((category, nm, owner_fn(nm), chunk))
    return out


SECTION_STARTS = re.compile(
    r"^(?:<system-reminder>\s*)?(?:"
    r"\w+ hook additional context:"
    r"|# Environment\b|# Memory\b|# MCP Server Instructions"
    r"|The following tools just became available"
    r"|The following deferred tools are (?:now|no longer) available"
    r"|The following MCP servers require authentication"
    r"|Available agent types for the Agent tool"
    r"|New agent types are now available"
    r"|The following skills are available"
    r"|Codebase and user instructions are shown below"
    r"|You are powered by the model"
    r"|Today's date is"
    r"|As you answer the user's questions"
    r"|While auto mode is active"
    r"|Attribution for git commits"
    r")", re.M)


def classify_text(text, ctx):
    """Split one text item into the reminder sections the harness concatenated, then label each."""
    starts = sorted({0} | {m.start() for m in SECTION_STARTS.finditer(text)})
    out = []
    for a, b in zip(starts, starts[1:] + [len(text)]):
        seg = text[a:b]
        if seg.strip():
            out += classify_segment(seg, ctx)
    return out


def classify_segment(text, ctx):
    """Return list of (category, name, owner_or_None, text) for one section."""
    t = text
    m = re.match(r"\s*(?:<system-reminder>\s*)?(\w+) hook additional context:", t)
    if m:
        cmd = ctx["hook_ctx_cmd"].get(t.strip()[:200]) or ctx["hook_ctx_cmd_any"].get(m.group(1))
        return [("hook output", m.group(1) + " hook", hook_owner(cmd), t)]
    if re.search(r"(Stop|SubagentStop|PreToolUse|PostToolUse|UserPromptSubmit)(:\S+)? hook (feedback|blocking error|says)", t) or t.lstrip().startswith("Stop hook feedback"):
        ev = re.search(r"(Stop|SubagentStop|PreToolUse|PostToolUse|UserPromptSubmit)", t).group(1)
        return [("hook output", ev + " hook", ctx["hook_by_event"].get(ev, "hook (unknown source)"), t)]
    if "Codebase and user instructions are shown below" in t or re.search(r"Contents of .*CLAUDE\.md", t):
        out = []
        for c, nm, ow, chunk in split_by(t, r"^Contents of (.+?) \(", "CLAUDE.md / memory", lambda n: None):
            low = (nm or "").lower()
            if "memory" in low and "claude.md" not in low:
                ow = "your auto-memory"
            elif nm in ("(header)",):
                ow = "Claude Code built-in"
            else:
                ow = "CLAUDE.md: " + os.path.basename(os.path.dirname(nm)) + "/" + os.path.basename(nm) if nm else "CLAUDE.md"
            out.append((c, nm, ow, chunk))
        return out
    if "The following skills are available" in t:
        return split_skill_listing(t)
    if "# MCP Server Instructions" in t or "MCP servers have provided instructions" in t:
        return split_by(t, r"^## (.+)$", "MCP server instructions", lambda n: mcp_owner(n) if n else None)
    if "Available agent types" in t or "agent types are now available" in t:
        return split_by(t, r"^- ([\w:-]+):", "agent listing", lambda n: None)
    if "deferred tools are now available" in t or "deferred tools are no longer available" in t:
        return [("deferred tool list", "(names)", "Claude Code built-in", t)]
    head = re.sub(r"<[^>]+>", "", t).strip().splitlines()
    head = next((h for h in head if h.strip()), "")[:60]
    return [("harness reminder", head, None, t)]


def classify_system_text(text):
    """Split a system-prompt block into its '# Heading' sections."""
    return split_by(text, r"^# (.+)$", "system prompt",
                    lambda n: "your auto-memory (system prompt section)" if n and n.strip().lower() == "memory" else None)


def mcp_owner(server):
    return "MCP: " + re.sub(r"[^a-z0-9]+", "_", server.lower()).strip("_")


def msg_hash(m):
    return hashlib.sha256(json.dumps(m, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf8")).hexdigest()


IMAGE_TOKENS = 1600  # an image block costs about (w*h)/750 tokens, capped near 1,600 after resizing


def content_chars(cc):
    """Size of a tool_result's content in chars, counting each image as IMAGE_TOKENS, not its base64."""
    if isinstance(cc, list):
        n = 0
        for b in cc:
            if isinstance(b, dict) and b.get("type") in ("image", "document"):
                n += IMAGE_TOKENS * CHARS_PER_TOKEN
            elif isinstance(b, dict) and b.get("type") == "text":
                n += len(b.get("text", ""))
            else:
                n += jlen(b)
        return n
    return jlen(cc)


def jlen(x):
    return len(x) if isinstance(x, str) else len(json.dumps(x, ensure_ascii=False))


# ---------------------------------------------------------------- analysis
def analyse(path, label_prefix=""):
    rows = load(path)
    shapes, blobs = {}, {}
    hook_ctx_cmd, hook_ctx_cmd_any, hook_by_event = {}, {}, {}
    tool_names_by_id = {}
    assistants = []  # list of (requestId, message)
    requests = []
    for d in rows:
        t = d.get("type")
        if t == "api-request-shape":
            shapes[d["shapeHash"]] = d["shape"]
        elif t == "api-request-blob":
            blobs[d["hash"]] = d["message"]
        elif t == "api-request":
            requests.append(d)
        elif t == "assistant":
            msg = d.get("message") or {}
            rid = d.get("requestId") or msg.get("id")
            if assistants and assistants[-1][0] == rid:
                assistants[-1][1]["content"].extend(msg.get("content") or [])
            else:
                assistants.append((rid, {"usage": msg.get("usage") or {}, "model": msg.get("model"),
                                         "content": list(msg.get("content") or [])}))
            for c in msg.get("content") or []:
                if c.get("type") == "tool_use":
                    tool_names_by_id[c["id"]] = (c.get("name"), c.get("input") or {})
        elif t == "attachment":
            a = d.get("attachment") or {}
            if a.get("type") == "hook_success":
                ev = a.get("hookEvent")
                own = hook_owner(a.get("command"))
                hook_by_event.setdefault(ev, own)
                so = a.get("stdout") or ""
                if "additionalContext" in so:
                    hook_ctx_cmd_any[ev] = a.get("command")
                    try:
                        ac = json.loads(so)["hookSpecificOutput"]["additionalContext"]
                        hook_ctx_cmd[(ev + " hook additional context: " + ac).strip()[:200]] = a.get("command")
                    except Exception:
                        pass
        elif t == "system" and d.get("subtype") == "stop_hook_summary":
            for hi in d.get("hookInfos") or []:
                hook_by_event.setdefault("Stop", hook_owner(hi.get("command")))
    ctx = {"hook_ctx_cmd": hook_ctx_cmd, "hook_ctx_cmd_any": hook_ctx_cmd_any, "hook_by_event": hook_by_event}

    def pieces_of_message(msg, assistant_fallback):
        out = []
        if msg is None:
            msg = assistant_fallback
        if msg is None:
            return out
        role = msg.get("role", "assistant")
        content = msg.get("content")
        if isinstance(content, str):
            content = [{"type": "text", "text": content}]
        for c in content or []:
            ty = c.get("type")
            if role == "assistant":
                continue  # handled exactly from the response's own usage (assistant_reread_pieces)
            if ty == "text":
                for cat, nm, ow, chunk in classify_text(c.get("text", ""), ctx):
                    out.append((cat, nm, ow, len(chunk)))
            elif ty == "tool_result":
                nm, inp = tool_names_by_id.get(c.get("tool_use_id"), ("?", {}))
                n = content_chars(c.get("content"))
                if nm == "Skill":
                    out.append(("skill body (loaded)", inp.get("skill", "?"), None, n))
                elif nm in ("Agent", "Task"):
                    out.append(("subagent report", inp.get("subagent_type", "general-purpose"), None, n))
                else:
                    out.append(("tool result", nm, mcp_owner(nm.split("__")[1]) if nm and nm.startswith("mcp__") else None, n))
            elif ty == "tool_addition":
                d = (c.get("tool") or {}).get("definition") or {}
                nm = d.get("name", "?")
                out.append(("tool definition", nm, mcp_owner(nm.split("__")[1]) if nm.startswith("mcp__") else None, jlen(d)))
            elif ty in ("image", "document"):
                out.append(("attachment", ty, None, IMAGE_TOKENS * CHARS_PER_TOKEN))
            else:
                out.append(("other", ty, None, jlen(c)))
        return out

    def assistant_reread_pieces(am):
        """An earlier response sent back as context: its size is known exactly (its output_tokens)."""
        u = am["usage"]
        out_tok = u.get("output_tokens") or 0
        think = min(((u.get("output_tokens_details") or {}).get("thinking_tokens")) or 0, out_tok)
        items = []
        for c in am["content"]:
            if c.get("type") == "tool_use":
                items.append(("tool call: " + str(c.get("name")), jlen(c.get("input"))))
            elif c.get("type") == "text":
                items.append(("answer text", len(c.get("text", ""))))
        res = [("model output (re-read)", "thinking", None, 0, think)] if think else []
        sc = sum(i[1] for i in items) or 1
        for nm, ch in items:
            res.append(("model output (re-read)", nm, None, 0, (out_tok - think) * ch / sc))
        return res

    asst_by_hash = {msg_hash({"role": "assistant", "content": m["content"]}): m for _, m in assistants}
    user_by_hash = {msg_hash(d["message"]): d["message"] for d in rows if d.get("type") == "user" and d.get("message")}
    unresolved = set()
    all_refs = set()
    for r in requests:
        all_refs.update(r.get("tail") or [])

    agg = defaultdict(lambda: {"tokens": 0.0, "units": 0.0, "category": "", "name": "", "owner": None, "model": None})
    totals = defaultdict(float)
    prev_msgs = {}
    diag = []
    a_idx = 0
    for r in requests:
        if a_idx >= len(assistants):
            break
        rid, amsg = assistants[a_idx]
        a_idx += 1
        usage = amsg["usage"]
        model = amsg.get("model") or "?"
        shape = shapes.get(r.get("shapeHash")) or {"system": [], "tools": []}
        qs = r.get("querySource", "")
        msgs = list(prev_msgs.get(qs, []))[: r.get("keep", 0)]
        for h in r.get("tail") or []:
            msgs.append(h)
        prev_msgs[qs] = msgs
        pieces = []
        for tdef in shape.get("tools") or []:
            nm = tdef.get("name", "?")
            pieces.append(("tool definition", nm, mcp_owner(nm.split("__")[1]) if nm.startswith("mcp__") else None, jlen(tdef)))
        for sb in shape.get("system") or []:
            txt = sb.get("text", "") if isinstance(sb, dict) else str(sb)
            for cat, nm, ow, chunk in classify_system_text(txt):
                pieces.append((cat, nm, ow, len(chunk)))
        # each message is referenced by sha256(sorted compact JSON); resolve against blobs,
        # user entries and assistant responses; anything unresolved is counted, not guessed
        for h in msgs:
            if h in blobs:
                pieces += pieces_of_message(blobs[h], None)
            elif h in asst_by_hash:
                pieces += assistant_reread_pieces(asst_by_hash[h])
            elif h in user_by_hash:
                pieces += pieces_of_message(user_by_hash[h], None)
            else:
                unresolved.add(h)
        tot_in = (usage.get("input_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0) + (usage.get("cache_creation_input_tokens") or 0)
        exact = sum(p[4] for p in pieces if len(p) > 4)
        est = sum(p[3] for p in pieces if len(p) == 4) / CHARS_PER_TOKEN or 1.0
        scale = max(tot_in - exact, 0) / est
        diag.append(round(scale * CHARS_PER_TOKEN, 2))  # implied chars per token for this request
        cr = usage.get("cache_read_input_tokens") or 0
        cw = usage.get("cache_creation_input_tokens") or 0
        cc = usage.get("cache_creation") or {}
        w1h = cc.get("ephemeral_1h_input_tokens") or 0
        w5 = cc.get("ephemeral_5m_input_tokens") or 0
        wweight = ((w1h * W_WRITE1H + w5 * W_WRITE5) / (w1h + w5)) if (w1h + w5) else W_WRITE1H
        pos = 0.0
        for p in pieces:
            cat, nm, ow, chars = p[:4]
            tk = p[4] if len(p) > 4 else chars / CHARS_PER_TOKEN * scale
            a, b = pos, pos + tk
            pos = b
            rd = max(0.0, min(b, cr) - a)
            wr = max(0.0, min(b, cr + cw) - max(a, cr))
            un = tk - rd - wr
            units = rd * W_READ + wr * wweight + un * W_UNCACHED
            key = (cat, nm)
            e = agg[key]
            e.update(category=cat, name=nm, owner=e["owner"] or ow)
            e["tokens"] += tk
            e["units"] += units
            totals["input_tokens"] += tk
            totals.setdefault("units_by_model", 0)
            totals["units_" + model] += units
        # output
        out_tok = usage.get("output_tokens") or 0
        think = ((usage.get("output_tokens_details") or {}).get("thinking_tokens")) or 0
        think = min(think, out_tok)
        outs = []
        for c in amsg["content"]:
            if c.get("type") == "tool_use":
                nm = c.get("name")
                if nm == "Skill":
                    outs.append(("model output", "Skill call: " + str((c.get("input") or {}).get("skill")), jlen(c.get("input"))))
                elif nm in ("Agent", "Task"):
                    outs.append(("model output", "Agent call: " + str((c.get("input") or {}).get("subagent_type", "general-purpose")), jlen(c.get("input"))))
                else:
                    outs.append(("model output", "tool call: " + str(nm), jlen(c.get("input"))))
            elif c.get("type") == "text":
                outs.append(("model output", "answer text", len(c.get("text", ""))))
        rest = out_tok - think
        sc = sum(o[2] for o in outs) or 1
        parts = [("model output", "thinking", think)] + [(o[0], o[1], rest * o[2] / sc) for o in outs]
        if not outs and rest:
            parts.append(("model output", "answer text", rest))
        for cat, nm, tk in parts:
            if tk <= 0:
                continue
            e = agg[(cat, nm)]
            e.update(category=cat, name=nm)
            e["tokens"] += tk
            e["units"] += tk * W_OUT
            totals["output_tokens"] += tk
            totals["units_" + model] += tk * W_OUT
        for e in agg.values():
            e["model"] = e["model"] or model
    return {"agg": dict(agg), "totals": dict(totals), "requests": len(requests),
            "messages_total": len(all_refs), "messages_unresolved": len(unresolved), "chars_per_token": diag, "model": assistants[0][1].get("model") if assistants else None}


def subagent_types(session_dir):
    out = []
    for meta in glob.glob(os.path.join(session_dir, "subagents", "*.meta.json")):
        jl = meta.replace(".meta.json", ".jsonl")
        try:
            m = json.load(open(meta, encoding="utf8"))
        except Exception:
            m = {}
        if os.path.exists(jl):
            out.append((m.get("agentType", "?"), jl))
    return out


def finalize(main_path, result=None, baseline=None, vanilla=False):
    main = analyse(main_path)
    session_dir = main_path[:-6] if main_path.endswith(".jsonl") else main_path
    rows = []
    for (cat, nm), e in main["agg"].items():
        rows.append(dict(category=cat, name=nm, owner=e["owner"], tokens=e["tokens"], units=e["units"], model=e["model"]))
    subs = []
    for typ, jl in subagent_types(session_dir):
        s = analyse(jl)
        tok = s["totals"].get("input_tokens", 0) + s["totals"].get("output_tokens", 0)
        units = sum(v for k, v in s["totals"].items() if k.startswith("units_"))
        rows.append(dict(category="subagent (whole run)", name=typ, owner="agent: " + typ, tokens=tok, units=units, model=s.get("model")))
        subs.append({"type": typ, "tokens": tok, "requests": s["requests"]})

    # owner resolution, using the baseline (vanilla) run to tell built-in from customisation
    base_keys = set()
    if baseline:
        base_keys = {(r["category"], r["name"]) for r in baseline["rows"]}
    for r in rows:
        if r["owner"]:
            continue
        cat, nm = r["category"], r["name"]
        if cat.startswith("model output"):
            r["owner"] = "task: model output (thinking, answers, tool calls)"
        elif cat == "tool result":
            r["owner"] = "task: tool results (files read, command output)"
        elif cat == "skill body (loaded)":
            r["owner"] = ("plugin: " + nm.split(":")[0]) if ":" in nm else "skill: " + nm
        elif cat == "subagent report":
            r["owner"] = "agent: " + nm
        elif baseline is not None:
            r["owner"] = "Claude Code built-in" if (cat, nm) in base_keys else "added by your setup (" + cat + ")"
        else:
            r["owner"] = "Claude Code built-in" if vanilla else "unclassified (no baseline given)"
        if cat == "skill listing" and baseline is not None and (cat, nm) not in base_keys and ":" not in nm:
            r["owner"] = "your skills (~/.claude/skills)"
        if cat == "agent listing" and baseline is not None and (cat, nm) not in base_keys:
            r["owner"] = "agent: " + nm

    # scale weighted units to exact reported cost, per model
    cost_by_model = {}
    if result:
        for m, mu in (result.get("modelUsage") or {}).items():
            cost_by_model[m] = mu.get("costUSD") or 0
    units_by_model = defaultdict(float)
    for r in rows:
        units_by_model[r["model"] or "?"] += r["units"]
    total_units = sum(units_by_model.values()) or 1
    total_cost = (result or {}).get("total_cost_usd")
    for r in rows:
        m = r["model"] or "?"
        if m in cost_by_model and units_by_model[m]:
            r["cost_usd"] = r["units"] / units_by_model[m] * cost_by_model[m]
        elif total_cost is not None:
            r["cost_usd"] = r["units"] / total_units * total_cost
        else:
            r["cost_usd"] = None
    tot_tok = sum(r["tokens"] for r in rows) or 1
    tot_cost = sum((r["cost_usd"] or 0) for r in rows) or None
    for r in rows:
        r["token_pct"] = 100 * r["tokens"] / tot_tok
        r["cost_pct"] = (100 * r["cost_usd"] / tot_cost) if (tot_cost and r["cost_usd"] is not None) else None
    rows.sort(key=lambda r: -(r["cost_usd"] or r["units"]))
    owners = defaultdict(lambda: {"tokens": 0.0, "cost_usd": 0.0})
    for r in rows:
        o = owners[r["owner"]]
        o["tokens"] += r["tokens"]
        o["cost_usd"] += r["cost_usd"] or 0
    owner_rows = [dict(owner=k, tokens=v["tokens"], cost_usd=v["cost_usd"], token_pct=100 * v["tokens"] / tot_tok,
                       cost_pct=(100 * v["cost_usd"] / tot_cost) if tot_cost else None) for k, v in owners.items()]
    owner_rows.sort(key=lambda r: -r["cost_usd"] if tot_cost else -r["tokens"])
    cpt = main["chars_per_token"]
    return {"rows": rows, "owners": owner_rows, "subagents": subs, "requests": main["requests"],
            "messages_total": main["messages_total"], "messages_unresolved": main["messages_unresolved"],
            "chars_per_token_range": [min(cpt), max(cpt)] if cpt else None,
            "total_tokens_attributed": tot_tok, "total_cost_attributed": tot_cost,
            "reported_cost": total_cost}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session")
    ap.add_argument("--result")
    ap.add_argument("--baseline", help="attribution JSON of the vanilla run, to tell built-in from customisation")
    ap.add_argument("--json")
    ap.add_argument("--vanilla", action="store_true", help="this session ran in --safe-mode: unlabelled items are built-in")
    a = ap.parse_args()
    res = json.load(open(a.result, encoding="utf8")) if a.result else None
    base = json.load(open(a.baseline, encoding="utf8")) if a.baseline else None
    out = finalize(a.session, res, base, a.vanilla)
    if a.json:
        json.dump(out, open(a.json, "w", encoding="utf8"), indent=1)
    print(f"requests={out['requests']} attributed_tokens={out['total_tokens_attributed']:.0f} "
          f"cost_attr={out['total_cost_attributed']} reported={out['reported_cost']} chars/token={out['chars_per_token_range']}")
    for o in out["owners"][:25]:
        cp = f"{o['cost_pct']:5.1f}%" if o["cost_pct"] is not None else "  n/a"
        print(f"{o['token_pct']:5.1f}% tok  {cp} cost  {o['owner']}")


if __name__ == "__main__":
    sys.exit(main())
