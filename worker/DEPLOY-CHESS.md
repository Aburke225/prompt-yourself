# Turning on Burke Bot game capture (one-time, ~5 minutes, $0)

The worker now has two chess routes that store games you play against Burke
Bot, so they can join the opening book. Until these steps are done, the
routes answer 503 and everything else works exactly as before.

## 1. Pick a secret key

Any random string, e.g. run this in a terminal and copy the output:

```bash
openssl rand -hex 16
```

You'll paste this same value in three places below.

## 2. Create the KV namespace and bind it

Cloudflare dashboard → **Storage & Databases → KV** → Create namespace →
name it `burke-bot-games`.

Then: **Workers & Pages → prompt-yourself-bot → Settings → Bindings →
Add → KV namespace** — variable name `CHESS_GAMES`, namespace
`burke-bot-games`.

## 3. Add the secret

Same Settings page → **Variables and Secrets → Add** — type **Secret**,
name `CHESS_KEY`, value = your key from step 1.

## 4. Paste the updated worker

Copy all of `worker.js` into the worker editor and **Deploy** (same as
every previous update).

## 5. Flag your own browser

Visit this once (with your key filled in) on each browser you play from:

```
https://aburke225.github.io/burke-bot/?key=YOUR_KEY
```

The page stores the key locally and strips it from the URL. From then on,
every finished game you play against the bot (6+ plies) is saved
automatically. Nobody else's games are stored — the page only sends games
when that key is present, and the worker rejects wrong keys.

## 6. Let the daily rebuild read the games

GitHub → `Aburke225/burke-bot` → Settings → Secrets and variables →
Actions → New repository secret — name `CHESS_KEY`, value = the same key.

That's it. The nightly action pulls the stored games, folds YOUR side's
moves into the book (never the bot's), retrains the style model, and
redeploys. Sanity check after step 4:

```bash
curl "https://prompt-yourself-bot.andrewburke225.workers.dev/chess/games?key=YOUR_KEY"
```

should print `[]` (empty list) rather than an error.
