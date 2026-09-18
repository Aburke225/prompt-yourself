#!/usr/bin/env python3
"""Daily model-health check: free-tier model IDs rot, so verify each provider's
configured model and replace dead ones automatically.

Fully dynamic — no hard-coded model list to rot:
 1. keep the current model while it is alive and answers a 1-token ping
    (stability: never churn a healthy model);
 2. when it dies, rank the provider's LIVE catalog by heuristics — filter
    out non-chat models by name (safety, embeddings, audio, vision, preview,
    reasoning spew), then prefer bigger parameter counts and contexts — and
    take the first candidate that passes a real ping.

Writes models.json when anything changes and a human-readable report to
model-check-report.txt. Providers whose API key is absent are checked as far
as possible without one (OpenRouter's catalog is public) and never churned
blindly. Exit code is always 0; the workflow reads the CHANGED/PROBLEM
markers from the report.
"""

import json
import os
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODELS = os.path.join(ROOT, "models.json")
REPORT = os.path.join(ROOT, "model-check-report.txt")

import re

BAD_WORDS = ("safety", "guard", "embed", "whisper", "tts", "content", "-code", "code:",
             "vision", "audio", "image", "imagen", "veo", "live", "ocr", "rerank",
             "moderation", "preview", "reasoning", "thinking", "compound", "exp")


def params_of(model_id):
    """Biggest parameter count named in the id, in billions (0 if unstated)."""
    sizes = re.findall(r"(\d+(?:\.\d+)?)b\b", model_id.lower())
    return max((float(x) for x in sizes), default=0.0)


def rank_gemini(mid):
    """Free-tier quota ordering: lite-latest aliases first (they self-update),
    then flash; pro burns free quota fastest so it ranks last."""
    m = mid.lower()
    return (("lite" in m and "latest" in m, "latest" in m, "lite" in m, "flash" in m), mid)

report = []


def log(line):
    print(line)
    report.append(line)


def http_json(url, headers=None, body=None, timeout=30):
    req = urllib.request.Request(url, headers=headers or {}, method="POST" if body else "GET",
                                 data=json.dumps(body).encode() if body else None)
    req.add_header("User-Agent", "burke-model-check/1.0")
    if body:
        req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def ping(provider, model, keys):
    """1-token live call. Returns 'ok', 'dead' (bad model/config) or 'skip'
    (no key, or a key/quota problem that model-churning would not fix)."""
    key = keys.get(provider)
    if not key:
        return "skip"
    try:
        if provider == "gemini":
            http_json(
                f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                headers={"x-goog-api-key": key},
                body={"contents": [{"role": "user", "parts": [{"text": "hi"}]}],
                      "generationConfig": {"maxOutputTokens": 1}},
            )
        else:
            url = ("https://api.groq.com/openai/v1/chat/completions" if provider == "groq"
                   else "https://openrouter.ai/api/v1/chat/completions")
            http_json(url, headers={"Authorization": f"Bearer {key}"},
                      body={"model": model, "max_tokens": 1,
                            "messages": [{"role": "user", "content": "hi"}]})
        return "ok"
    except urllib.error.HTTPError as e:
        if e.code == 429:
            return "ok"  # quota, not a dead model
        if e.code in (401,):
            log(f"PROBLEM {provider}: key rejected (401) - fix the key, not the model")
            return "skip"
        return "dead"
    except Exception as e:
        log(f"note {provider}: ping error {e} - treating as inconclusive")
        return "skip"


def catalog(provider, keys):
    """Live model ids, or None when unknowable (no key)."""
    try:
        if provider == "openrouter":
            d = http_json("https://openrouter.ai/api/v1/models")
            return {m["id"]: m.get("context_length", 0) for m in d["data"]}
        if provider == "groq":
            if not keys.get("groq"):
                return None
            d = http_json("https://api.groq.com/openai/v1/models",
                          headers={"Authorization": f"Bearer {keys['groq']}"})
            return {m["id"]: 0 for m in d["data"]}
        if provider == "gemini":
            if not keys.get("gemini"):
                return None
            d = http_json("https://generativelanguage.googleapis.com/v1beta/models",
                          headers={"x-goog-api-key": keys["gemini"]})
            return {m["name"].split("/")[-1]: 0
                    for m in d.get("models", [])
                    if "generateContent" in m.get("supportedGenerationMethods", [])}
    except Exception as e:
        log(f"note {provider}: catalog fetch failed ({e})")
    return None


# OpenRouter's own router over whatever is currently free. Like gemini's
# "-latest" aliases it cannot be deprecated, because it resolves at request
# time instead of naming a model, which is the whole problem this script
# exists to paper over. Verified against the public catalog: priced 0/0.
#
# NOT "openrouter/auto", and especially NOT "openrouter/auto:free" - the first
# is priced -1/-1, meaning variable, and the second is not a model id at all,
# so asking for it silently lands on the paid router. That would break the $0
# rule quietly, which is the worst way for it to break.
OPENROUTER_ALIAS = "openrouter/free"


def dynamic_pick(provider, live):
    good = [(mid, ctx) for mid, ctx in live.items()
            if not any(b in mid.lower() for b in BAD_WORDS)
            and (provider != "openrouter" or mid.endswith(":free")
                 or mid == OPENROUTER_ALIAS)]
    if provider == "gemini":
        good.sort(key=lambda x: rank_gemini(x[0]), reverse=True)
    elif provider == "openrouter":
        # the alias first: it self-updates, so converging back to it means a
        # future replacement is one fewer thing that can rot
        good.sort(key=lambda x: (x[0] != OPENROUTER_ALIAS, -params_of(x[0]), -x[1]))
    else:
        good.sort(key=lambda x: (-params_of(x[0]), -x[1]))
    return [mid for mid, _ in good[:5]]


def choose(provider, current, keys):
    live = catalog(provider, keys)
    if live is not None:
        # gemini "latest" aliases may not appear in the catalog by that name;
        # for them the ping is the real liveness signal
        current_alive = current in live or (provider == "gemini" and "latest" in current)
        if current_alive and ping(provider, current, keys) in ("ok", "skip"):
            return current, "healthy"
        log(f"{provider}: '{current}' is gone or failing - picking from the live catalog")
        for cand in dynamic_pick(provider, live):
            if cand == current:
                continue
            if ping(provider, cand, keys) == "ok" or (not keys.get(provider) and cand in live):
                return cand, "replaced"
        log(f"PROBLEM {provider}: nothing in the live catalog passed verification")
        return current, "stuck"
    # no catalog access and maybe no key: never churn without evidence
    st = ping(provider, current, keys)
    if st == "ok":
        return current, "healthy"
    if st == "skip":
        return current, "unverified (no key)"
    log(f"PROBLEM {provider}: current model failing and no catalog access to pick from")
    return current, "stuck"


def main():
    keys = {
        "gemini": os.environ.get("GEMINI_API_KEY", ""),
        "groq": os.environ.get("GROQ_API_KEY", ""),
        "openrouter": os.environ.get("OPENROUTER_API_KEY", ""),
    }
    cfg = json.load(open(MODELS))
    changed = False
    for provider in ("gemini", "groq", "openrouter"):
        new, status = choose(provider, cfg[provider], keys)
        log(f"{provider}: {cfg[provider]} -> {new} [{status}]")
        if new != cfg[provider]:
            cfg[provider] = new
            changed = True
    if changed:
        from datetime import date
        cfg["updated"] = date.today().isoformat()
        json.dump(cfg, open(MODELS, "w"), indent=1)
        log("CHANGED models.json written")
    else:
        log("no changes needed")
    open(REPORT, "w").write("\n".join(report) + "\n")


if __name__ == "__main__":
    main()
