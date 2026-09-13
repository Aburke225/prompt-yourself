#!/usr/bin/env python3
"""Daily model-health check: free-tier model IDs rot, so verify each provider's
configured model and replace dead ones automatically.

Three tiers per provider:
 1. keep the current model if it is alive and answers a 1-token ping;
 2. otherwise take the first ALIVE entry from a ranked preference list;
 3. if the whole list is dead, pick from the provider's live catalog by
    heuristics (skip safety/embedding/code-oriented models, prefer large
    context) — the bots never go dark just because opinions went stale.

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

PREFERRED = {
    "gemini": ["gemini-flash-lite-latest", "gemini-flash-latest", "gemini-2.5-flash-lite", "gemini-2.5-flash"],
    "groq": ["openai/gpt-oss-120b", "openai/gpt-oss-20b", "llama-3.3-70b-versatile", "qwen/qwen3.6-27b"],
    "openrouter": [
        "nvidia/nemotron-3-super-120b-a12b:free",
        "google/gemma-4-31b-it:free",
        "nex-agi/nex-n2.5-pro:free",
        "nvidia/nemotron-3-ultra-550b-a55b:free",
    ],
}
BAD_WORDS = ("safety", "guard", "embed", "whisper", "tts", "content", "-code", "code:", "vision")

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


def dynamic_pick(provider, live):
    good = [(mid, ctx) for mid, ctx in live.items()
            if not any(b in mid.lower() for b in BAD_WORDS)
            and (provider != "openrouter" or mid.endswith(":free"))]
    good.sort(key=lambda x: -x[1])
    return [mid for mid, _ in good[:4]]


def choose(provider, current, keys):
    live = catalog(provider, keys)
    candidates = [current] + [c for c in PREFERRED[provider] if c != current]
    if live is not None:
        alive = [c for c in candidates if c in live]
        emergency = [c for c in dynamic_pick(provider, live) if c not in alive]
        pool = alive + emergency
        if current in live and ping(provider, current, keys) in ("ok", "skip"):
            return current, "healthy"
        log(f"{provider}: '{current}' is gone or failing - hunting a replacement")
        for cand in pool:
            if cand == current:
                continue
            if ping(provider, cand, keys) in ("ok",) or (not keys.get(provider) and cand in live):
                return cand, "replaced"
        log(f"PROBLEM {provider}: no live candidate found (checked {len(pool)})")
        return current, "stuck"
    # no catalog access: ping is the only signal; never churn without evidence
    st = ping(provider, current, keys)
    if st in ("ok", "skip"):
        return current, "healthy" if st == "ok" else "unverified (no key)"
    log(f"{provider}: '{current}' failed its ping - trying preferences")
    for cand in PREFERRED[provider]:
        if cand != current and ping(provider, cand, keys) == "ok":
            return cand, "replaced"
    log(f"PROBLEM {provider}: current model failing and no candidate pings")
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
