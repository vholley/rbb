---
name: documents
description: Choose, once per repository, whether RBB commits its records (spec, build log, check, review) to the repository, or keeps them only on this machine and puts everything a reviewer needs in the pull request body.
argument-hint: committed|none
---

Arguments: $ARGUMENTS

1. If there is no argument, ask with `AskUserQuestion`: "Where should RBB keep its records for this repository?", with "Committed in the repository (Recommended)": the reviewer gets them as files in the pull request, and git history shows the spec was not changed after approval; and "Only on this machine": nothing reaches the repository, the pull request body carries the review, and only a hash shows the spec was not changed.
2. Run the plugin workflow `rbb:conventions` with args `{"documents": "<committed or none>"}` and wait. If it returns a question about the commit style, ask it with `AskUserQuestion`, its recommendation first and labelled "(Recommended)", then run it again with args `{"documents": "<the same>", "commit_style": "<their choice>"}`.
3. Report the mode saved, or the error as written. For "none", say that `.rbb/.gitignore` now keeps every RBB file out of git, and that it is not committed either.
