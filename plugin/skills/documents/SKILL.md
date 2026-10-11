---
name: documents
description: Choose, or change, whether RBB commits its records (spec, build log, check, review) to the repository, or keeps them only on this machine and puts everything a reviewer needs in the pull request body. The setup with the mode given.
argument-hint: committed|none
---

Arguments: $ARGUMENTS

1. If the argument is neither `committed` nor `none`, ask with `AskUserQuestion`: "Where should RBB keep its records for this repository?", with "Committed in the repository (Recommended)": the reviewer gets them as files in the pull request, and git history shows the spec was not changed after approval; and "Only on this machine": nothing reaches the repository, the pull request body carries the review, and only a hash shows the spec was not changed.
2. Invoke the skill `rbb:setup` with the Skill tool, with the argument `documents=<committed or none>`, and let it ask, run and report as it does. Add nothing to its report.
