# Working rules for AI agents (ChatGPT/Codex and Claude)

Two AI agents work on this repo. These rules keep them from overwriting each other.

## One copy, one branch
- Work only in this folder (`~/Desktop/AI DM SETTER`), on the `main` branch.
- Never create extra worktrees, clones or long-lived branches.

## Start and finish every task the same way
1. **Before editing anything:** `git pull --rebase origin main`.
   - If you have uncommitted changes, commit them first. Then pull and resolve every conflict by keeping BOTH sides' work.
   - Never resolve a conflict by taking "ours" or "theirs" wholesale.
2. **Before committing:** run `npm test`. Do not commit or push if it fails.
3. **When done:** commit with a clear message, then `git push origin main`. Never leave work uncommitted at the end of a task; the other agent cannot see it.
4. **Never force-push**, and never rewrite history on `main`.

## Pushing to `main` deploys to production
- Railway deploys `main` to https://ai-dm-setter-production.up.railway.app on every push.
- Only push work that is finished and tested.

## Who owns what
- **ChatGPT/Codex:** UI and styling: `public/css/`, `public/js/pages/*`, `public/js/ui.js`, `public/index.html`.
- **Claude:** backend, data and deploys: `server.js`, `lib/`, `migrations/`, `test/`.
- If a task needs a file the other agent owns:
  - Pull first.
  - Change only what the task needs.
  - Say so in the commit message.
- Don't reformat or rewrite whole files you don't own.
- Don't change an API response shape without updating its callers in the same commit.

## One agent at a time
The owner runs one agent at a time. If `git status` shows uncommitted changes you didn't make, stop and ask the owner before touching them.
