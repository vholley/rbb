---
name: pr
description: Prepare the pull request for a checked RBB change - commit the check and the review, and write a short body (goal, changes, check result, link to the review) into the project's PR template. Opens or updates the pull request only when the requester asks.
argument-hint: <change> [post]
---

Arguments: $ARGUMENTS

The first word of the arguments is the change name. The second word, when it is `post`, asks to post the pull request. Nothing else is an argument.

1. If `.rbb/config.json` does not exist, the repository is not set up: invoke the skill `rbb:setup` with the Skill tool and no argument first, and stop if it reported an error. Run the plugin workflow `rbb:write-pr` with the Workflow tool, with args `{"change": "<the change name>"}` (an object with the change name alone, never the whole argument text), and wait. Do not write any file yourself.
2. If it returned an error, show the error as written and stop.
3. Show the requester the title it returned and `.rbb/<change>/pr.md` exactly as written. Add nothing of your own, except, when `body_complete` is false, that the review could not be included in the body and stays in `.rbb/<change>/review.md`.
4. Post only if the requester asked to: the second argument is `post`, or they asked in their own words to open, create, post or update the pull request. Otherwise, end by giving them the commands from step 6 to run when they choose, and stop.
5. Before posting, run these checks, every one of them, and only then ask once with `AskUserQuestion`, with "Post it" first and "Not now" second:
   - `gh auth status`: `gh` is installed and signed in, and the result has a `github` repository. If either is missing, say which, give the commands from step 6, and stop.
   - The base branch: `gh repo view <github> --json defaultBranchRef --jq .defaultBranchRef.name`.
   - The head branch: the returned `branch`; or, when `needs_branch` is true, `suggested_branch`, which will be created at the current commit.
   - Whether a pull request already exists for that head branch: `gh pr list --repo <github> --head <head> --state open --json number,url`. If one exists, the posting updates it; if none, it creates one.
   The question names the repository, the base, the head branch (and that it will be created, if so), and whether a pull request is created or an existing one updated by number. Do not describe posting to a private repository as public.
6. On "Post it", run, in order, stopping at the first failure and showing its output:
   1. Only when `needs_branch` is true: `git switch -c <suggested_branch>`. Never move, reset or rewrite the base branch.
   2. `git push -u origin <head>`.
   3. To create: `gh pr create --repo <github> --base <base> --head <head> --title "<title>" --body-file .rbb/<change>/pr.md`. To update: `gh pr edit <number> --repo <github> --body-file .rbb/<change>/pr.md`.
7. Report the pull request's URL as `gh` printed it. Never force-push, never merge, never add reviewers or labels. Post the body exactly as the workflow wrote it: add no attribution, signature or "Generated with" line. The body is the requester's record, and RBB's own authorship is already stated in it where the template asks.
