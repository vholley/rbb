---
name: setup
description: Set RBB up in this repository, once - where the records live, where its permission rules go (and write them), the commit style and branch naming its commits follow, and the project's test command. Runs by itself the first time /rbb, /rbb:goal or /rbb:approve is used in a repository. Run again, it changes only what it is asked to and adds only what is missing.
argument-hint: [documents=committed|none] [permissions=.claude/settings.json|.claude/settings.local.json|none]
---

Arguments: $ARGUMENTS

1. Find out, with Glob and without reading them, whether `.rbb/config.json` and `.claude/settings.json` exist.
2. Ask, in one `AskUserQuestion` call, the questions the arguments do not already answer:
   - When `documents=` is not given: "Where should RBB keep its records for this repository?", with "Committed in the repository (Recommended)": the reviewer gets them as files in the pull request, and git history shows the spec was not changed after approval; and "Only on this machine": nothing reaches the repository, the pull request body carries the review, and only a hash shows the spec was not changed.
   - When `permissions=` is not given and `.rbb/config.json` does not exist: "Where should RBB's permission rules go, so that only real decisions ask you?", with ".claude/settings.json, shared with the team through git" and ".claude/settings.local.json, this machine only", the first labelled "(Recommended)" when `.claude/settings.json` exists (the team already shares its Claude Code settings there) and the second otherwise; and last "Nowhere: show me the rules". Its description says that RBB only adds allow rules for the commands it runs, removes nothing, and never allows deleting records, pushing or posting, which keep asking.
   - When `permissions=` is not given and `.rbb/config.json` exists, ask nothing about it: the workflow keeps the earlier choice.
3. Say, in one sentence, that Claude Code may ask to allow a few read-only commands while the repository is examined, and that these are among the rules being written. Then run the plugin workflow `rbb:setup` with the Workflow tool, with args `{"documents": "<committed or none>", "permissions": "<the file, or none>"}`, leaving out a key that has no answer, and wait.
4. If it returned an error, show it as written and stop.
5. If it returned `questions`, ask them in one `AskUserQuestion` call, each as written, with its `options` as the choices, the recommended one first and labelled "(Recommended)", each option described by its `means`, and the recommended one's description adding the `because` and the `affects`. Then run the workflow again with the same args plus `"commit_style": "<their answer>"` and `"test_command": "<their answer>"` for the questions asked (`none` when they chose none; their own words when they typed a command), and wait. An answer stands; never ask it again.
6. If the run returned an error, show it as written and stop. Otherwise report, from the result and nothing else:
   - the documents mode, and for `none` that `.rbb/.gitignore` now keeps every RBB file out of git, itself included;
   - the commit style and the branch naming from `config`, and whether they were detected from the history or chosen (`by`);
   - the test command from `config.test`, or that none is allowed;
   - the permission rules: when `permissions.added` lists rules, how many were added to which file; when it is empty, that the file already held them all; when `permissions.file` is null or `permissions.error` is set, say why nothing was written (the error as written, or that they chose so) and show `rules` as a JSON `permissions.allow` list for them to add by hand;
   - when `permissions.ignored` is false, that git does not ignore `.claude/settings.local.json`, so it may want a line in `.gitignore`;
   - when the result has a `note`, the note as written;
   - that the GitHub CLI, signed in, is needed only to post pull requests from inside RBB.
7. Write no file yourself, and change no setting the workflow did not report.
