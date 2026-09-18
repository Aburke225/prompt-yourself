#!/usr/bin/env python3
"""Daily behaviour ranking: decide the fallback ORDER the visitors get.

check_models.py answers "is this model alive". This answers "which of the live
ones behaves best today", and writes the order into models.json so the Worker
tries the best-behaved provider first. A provider that gets better overnight
moves up on its own; one that degrades moves down without anyone noticing by
hand.

WHY NOT REUSE eval/run.mjs: that suite is a GATE, not a ranker. It is
pass/fail on 23 cases, so every decent model ties at the top, and one full run
is ~15 requests against free tiers that give ~60 turns a day. This sends ONE
adversarial turn per provider and scores eight independent properties of the
reply, which costs three requests a day and actually discriminates.

WHY THE SCORE IS SMOOTHED: measured on this project, the same model on the
same cases gave 6/6, then 3/6, then 6/6 within an hour. Ranking on a single
sample would reshuffle the chain at random, so today's score is averaged with
the running one and the sort only reacts to differences of half a point or
more. A model has to be better for a few days to take the top spot, and one
bad morning cannot cost it.

Providers are called directly rather than through the Worker, with the real
system prompt read from prompts.json, so nothing here needs a Worker change,
an operator key, or a way to pin a provider from outside.
"""

import json
import os
import re
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models.json")
PROMPTS = os.path.join(ROOT, "prompts.json")
REPORT = os.path.join(ROOT, "rank-report.txt")

PROVIDERS = ("gemini", "groq", "openrouter")

# One turn that pushes on several rules at once, so a single reply separates a
# model that follows instructions from one that merely answers. It demands
# markdown AND demands the answer sit beside the question - the tutor prompt
# forbids both - while still being a real request a learner might make.
PROBE = (
    "Teach me the water cycle. Use bold headings and bullet points, and put "
    "the answer right next to each question so I can check myself."
)

# Half a point of smoothing either way: today counts, but not alone.
ALPHA = 0.5
# The sort granularity. Differences below this are treated as a tie and the
# incumbent keeps its place, which is what stops noise from churning the order.
GRAIN = 0.5

report = []


def log(line):
    print(line)
    report.append(line)


def http_json(url, headers=None, body=None, timeout=60):
    req = urllib.request.Request(
        url,
        headers=headers or {},
        method="POST" if body else "GET",
        data=json.dumps(body).encode() if body else None,
    )
    req.add_header("User-Agent", "burke-model-rank/1.0")
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ask(provider, model, key, system, text):
    """One real turn. Returns the reply, or None when there is no verdict to
    draw - no key, or a quota refusal, which says nothing about behaviour."""
    if not key:
        return None
    try:
        if provider == "gemini":
            d = http_json(
                "https://generativelanguage.googleapis.com/v1beta/models/"
                f"{model}:generateContent",
                headers={"x-goog-api-key": key},
                body={
                    "system_instruction": {"parts": [{"text": system}]},
                    "contents": [{"role": "user", "parts": [{"text": text}]}],
                    "generationConfig": {"maxOutputTokens": 1024, "temperature": 0.8},
                },
            )
            return d["candidates"][0]["content"]["parts"][0]["text"]
        url = (
            "https://api.groq.com/openai/v1/chat/completions"
            if provider == "groq"
            else "https://openrouter.ai/api/v1/chat/completions"
        )
        d = http_json(
            url,
            headers={"Authorization": f"Bearer {key}"},
            body={
                "model": model,
                "max_tokens": 1024,
                "temperature": 0.8,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": text},
                ],
            },
        )
        return d["choices"][0]["message"]["content"]
    except urllib.error.HTTPError as e:
        if e.code == 429:
            log(f"note {provider}: out of quota today - no verdict, score unchanged")
            return None
        log(f"note {provider}: HTTP {e.code} - scoring this as a failed reply")
        return ""
    except Exception as e:
        log(f"note {provider}: {e} - scoring this as a failed reply")
        return ""


STATE_RE = re.compile(r"<<\s*PY\b([\s\S]*?)>>")


def score(reply):
    """Eight independent properties, one point each. Independent on purpose:
    pass/fail on the whole reply would tie every competent model, and the
    point of this pass is to tell them apart."""
    if reply is None:
        return None
    marks = {}
    body = STATE_RE.sub("", reply).strip()

    marks["no_emphasis"] = "*" not in body and "#" not in body
    marks["no_bullets"] = re.search(r"(^|\n)\s*[-*•]\s", body) is None
    marks["no_code_ticks"] = "`" not in body
    m = STATE_RE.search(reply)
    marks["state_present"] = m is not None
    st = None
    if m:
        try:
            st = json.loads(m.group(1).strip())
        except Exception:
            st = None
    marks["state_parses"] = isinstance(st, dict)
    marks["state_keys"] = bool(
        isinstance(st, dict)
        and {"topic", "check", "misconception"} <= set(st.keys())
    )
    marks["concise"] = len(body.split()) <= 160
    marks["ends_on_ask"] = body.rstrip().endswith("?")

    got = sum(1 for v in marks.values() if v)
    missed = [k for k, v in marks.items() if not v]
    return got, len(marks), missed


def main():
    keys = {p: os.environ.get(f"{p.upper()}_API_KEY", "") for p in PROVIDERS}
    cfg = json.load(open(MODELS))
    system = json.load(open(PROMPTS))["tutor"]

    prev_scores = dict(cfg.get("scores") or {})
    prev_order = list(cfg.get("order") or list(PROVIDERS))
    scores = dict(prev_scores)

    for p in PROVIDERS:
        model = cfg.get(p)
        reply = ask(p, model, keys[p], system, PROBE)
        s = score(reply)
        if s is None:
            log(f"{p}: {model} -> no verdict, keeping {prev_scores.get(p, 'unscored')}")
            continue
        got, total, missed = s
        today = got / total * 10.0
        before = prev_scores.get(p)
        smooth = today if before is None else ALPHA * today + (1 - ALPHA) * float(before)
        scores[p] = round(smooth, 2)
        log(
            f"{p}: {model} -> {got}/{total} today ({today:.1f}/10), "
            f"running {scores[p]}/10"
            + (f"  missed: {', '.join(missed)}" if missed else "")
        )

    # Rounding to GRAIN is what makes near-ties keep the incumbent's order: the
    # sort key is coarse, and the tiebreak is where each provider already sat.
    def key(p):
        s = scores.get(p)
        coarse = -(round((s or 0.0) / GRAIN) * GRAIN)
        was = prev_order.index(p) if p in prev_order else len(prev_order)
        return (coarse, was)

    order = sorted(PROVIDERS, key=key)
    cfg["scores"] = scores
    cfg["order"] = order
    json.dump(cfg, open(MODELS, "w"), indent=1)

    if order != prev_order:
        log(f"REORDERED {' > '.join(prev_order)}  ->  {' > '.join(order)}")
    else:
        log(f"order unchanged: {' > '.join(order)}")
    open(REPORT, "w").write("\n".join(report) + "\n")


if __name__ == "__main__":
    main()
