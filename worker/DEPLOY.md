# Deploying the chat relay ($0, no credit card at any step)

The site's chat works without this (it shows the copy-paste fallback).
Deploying this Worker is what makes the bots live. Total time: ~10 minutes.

**The $0 rule: never attach a payment method to any account below.** Free
tiers then hard-stop with errors instead of billing, and the site falls back
gracefully.

## 1. Get a free Gemini API key (2 min)

1. Go to https://aistudio.google.com and sign in with a Google account.
2. Click **Get API key** → **Create API key**.
3. Copy the key somewhere safe. Do NOT enable billing anywhere.

Optional but recommended backups (same idea, no card):
- **Groq**: https://console.groq.com → API Keys → Create.
- **OpenRouter**: https://openrouter.ai → sign in → Keys → Create
  (its `:free` models cost nothing).

## 2. Create the Worker on Cloudflare (5 min)

1. Sign up free at https://dash.cloudflare.com (no card).
2. In the left sidebar: **Workers & Pages** → **Create** → **Create Worker**.
3. Name it `prompt-yourself-bot`, click **Deploy** (deploys the hello-world).
4. Click **Edit code**, delete everything, paste the entire contents of
   `worker.js`, then **Save and deploy**.
5. Back on the Worker's page: **Settings** → **Variables and Secrets** →
   **Add** → type **Secret**:
   - Name `GEMINI_API_KEY`, value = your key from step 1.
   - (Optional) `GROQ_API_KEY` and `OPENROUTER_API_KEY` the same way.
6. Copy the Worker's URL — it looks like
   `https://prompt-yourself-bot.<your-subdomain>.workers.dev`.

## 3. Wire the site to it (Claude does this)

Give Claude the Worker URL. It goes into one line at the top of `chat.js`
(`var ENDPOINT = '...'`), gets pushed, and the bots go live.

## Quick test (optional)

```bash
curl -s -X POST "https://prompt-yourself-bot.<your-subdomain>.workers.dev" \
  -H "content-type: application/json" \
  -H "origin: https://aburke225.github.io" \
  -d '{"bot":"tutor","messages":[{"role":"user","content":"I want to learn basic budgeting. Complete beginner."}]}'
```

A JSON `{"reply":"...","provider":"gemini"}` means it works.

## Notes

- The Worker only accepts requests whose Origin is the site (or localhost),
  rate-limits each visitor to 60 messages/hour, and caps ~600 messages/day
  globally — all far inside every free tier.
- If Google deprecates a model, the default alias `gemini-flash-lite-latest`
  tracks the newest one automatically; you can also override models under
  **Settings → Variables** (plain-text vars, names in `wrangler.toml`).
- When every provider's quota is exhausted, the site shows:
  "the free bot is resting — here's the same coach as a copy-paste prompt."
