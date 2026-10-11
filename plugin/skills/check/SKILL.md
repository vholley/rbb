---
name: check
description: Check a change against its approved RBB spec and plan. The check runs as a workflow that never sees the builder's conversation, and writes .rbb/<change>/check.json and the review page, review.md.
argument-hint: <change> [grouped|per-hunk]
---

Arguments: $ARGUMENTS

1. Run the plugin workflow `rbb:check-change` with the Workflow tool. Pass `args` as an object: `{"change": "<the first argument>", "mode": "<the second argument, or grouped>"}`. Do not write any file yourself.
2. When it finishes, show the requester `.rbb/<change>/review.md` exactly as written. Add nothing of your own: no summary, no judgement of the result, no advice. If the result says `review_recorded` is false, say instead that the review page could not be saved and that `.rbb/<change>/check.json` holds the result.
3. If the workflow returned an error instead, show the error as written.
