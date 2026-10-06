# CLAUDE.md

Read `docs/HANDOFF.md` first. Its "▶ START HERE" section says what is being
worked on now, and its Rules section is not negotiable.

## Working with the owner (Paul)

- He is learning while he builds. Answer in short, plain, casual English. Give
  the steps first, and the reasons only when he asks.
- Every code block he sees comes with bullet-point notes saying what it does.
- No symbol shorthand in text people read: no `·` separators, no `a = b` in
  titles or captions. Write short sentences instead.
- Keep everything free: no paid services, APIs or plans, for him or for the
  students.
- Look up model, price, release and limit facts before stating them.
- Do the work and the careful review yourself, even when the session says
  Ultracode is on (his choice, 2026-10-06). Run a workflow or subagents only
  when he asks for one by name. His plan is Claude Pro: three workflows in three
  days (2026-10-04 to 10-06) each hit his limit and returned nothing, because
  every agent that reads source costs about 200k to 270k tokens (NOTES §73.7).

## Cloud sessions

A cloud session runs on a Linux VM with a fresh clone of this repo. Nothing from
his PC is there except what is committed.

- Commit and push **your own branch**: in the cloud that is the only way he sees
  the work. Never push to `main`, and never deploy production unless he says so
  in the session.
- When a step is done and verified, deploy a preview he can open on his phone:
  `npx expo export --platform web`, then
  `npx wrangler pages deploy dist --project-name=learning-app --branch=<your-branch>`.
  Give him the preview link, then open a PR.
- Secrets come from the environment's variables. Never print them, commit them
  or write them to a file.
- Some things need his Windows PC or his iPhone, like building and trying the
  `.exe` or checking a long-press. Say so, and give him the exact steps.
