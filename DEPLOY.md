# Deploying

The live demo URL is a mandatory submission item, so this is the part not to leave until last.

## 1. Push to GitHub

The repository is committed locally and the empty GitHub repository already exists at
https://github.com/MFahd7/beyond-the-chatbot. The remote is configured with the username in the URL,
so the credential helper asks for **MFahd7** rather than reusing whatever account is already signed
in on the machine.

```bash
git push -u origin main
```

A browser window opens; sign in as MFahd7. Any stored credential for another account is left alone.

**Commit identity.** This repository sets `user.name` and `user.email` locally only; no global git
config is touched. The author address is GitHub's noreply address for the MFahd7 account
(`53822500+MFahd7@users.noreply.github.com`), so commits link to the account without publishing a
private address.

**Size.** `data/` is about 9.6 MB of committed JSON — the corpus, the feature vectors, the fitted
weights and the evaluation. Well inside GitHub's limits, no LFS needed. `data/raw/` is gitignored:
it is 28 MB of re-fetchable API pages and `data/corpus.json` supersedes it.

## 2. Deploy on Vercel

Zero configuration. Import the repository at [vercel.com/new](https://vercel.com/new) and accept the
detected Next.js defaults.

**Remove the environment variables Vercel offers to add.** The import screen scrapes every key out
of `.env.example` and pre-fills all three with blank values, under an "Environment Variables, 3
Detected" panel. Click the minus button beside each. The app is built to run with none set, which is
the point: a judge cloning at midnight with no API key gets a fully working demo, and so does the
hosted build.

Nothing needs configuring because nothing is fetched at request time. `data/corpus.json` is
committed and read from the filesystem inside the serverless function, which is why the demo works
with no network access, no token and no database.

Then put the URL at the top of [README.md](README.md), where the placeholder is.

## 3. Check it

```
GET  /                    the docket
POST /api/docket          { model?, now? } → the decisions
```

On the deployed URL, confirm:

- The header reads **1,010 open issues → 65 decisions**.
- The first card is the 115-issue canary sweep, and `\` splits the screen against the real issue
  list.
- `?` reports **759 covered · 241 withheld**, and those add to 1,000.
- `i` shows five models, two of them marked "not used".
- Pressing `r` then `1` on any model-driven card reorders the queue and prints what moved.

First request on a cold instance parses 9 MB of JSON, so expect a beat before the first paint;
afterwards the corpus is held in module scope and requests are a few hundred milliseconds.

## Optional: make the actions real

By default, approving a case writes to a local mutation log and nothing leaves the process. The
corpus is somebody else's bug tracker and a demo has no business commenting on 1,000 open issues
that real people are waiting on.

To execute the same drafts for real against a repository **you own**:

```bash
GITHUB_WRITE_TOKEN=ghp_...        # needs `issues:write` on the target repo only
DOCKET_TARGET_REPO=MFahd7/triage-sandbox
```

The review model is identical either way: the operator approves the exact request shown on the card,
and the log records what was approved and what it would take to undo. Point this at
`vercel/next.js` and it will try, which is why it is off by default and why the token is a separate
variable from the read-only `GITHUB_TOKEN` used for refreshing the corpus.

## Refreshing the data

The committed corpus was fetched on the date shown in the app header. To re-pull:

```bash
npm run data:refresh      # fetch → build → fit, about 6 minutes unauthenticated
```

`GITHUB_TOKEN` raises the search limit from 10/min to 30/min. Pages are cached under `data/raw/`, so
an interrupted fetch resumes instead of starting over. `npm run data:fit` alone refits from the
committed `data/features.json` with no network at all, which is how the published weights can be
reproduced offline.
