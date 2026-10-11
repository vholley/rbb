# Using RBB

RBB (Record Before Build) is a Claude Code plugin. Before a change is built, a person approves one spec that says what will change, why, and how. After the build, a check that never saw the builder's conversation compares the change with that spec. The reviewer gets a record of what was asked, what was done, why, and where they differ.

Why it works this way is in [design.md](design.md). This page is about using it.

## Setting up

Clone the repository and load its plugin:

```bash
git clone https://github.com/vholley/rbb
```

```bash
claude --plugin-dir rbb/plugin
```

Or install it as a plugin, which Claude Code then loads in every session:

```bash
claude plugin marketplace add vholley/rbb
```

```bash
claude plugin install rbb@rbb
```

RBB needs Claude Code and git, nothing else: no language runtime, and no program of its own. Everything it works out by code runs inside Claude Code's workflows, and everything it writes is a file under `.rbb/` in your repository.

The first time you run `/rbb` in a repository, RBB sets itself up before anything else, and nothing later asks for a setting. The setup (`/rbb:setup`, which you can also run yourself) asks two things first:

- **Where the records live.** Committed (the default): the spec, the build log, the check and the review are committed under `.rbb/<change>/`, reach the pull request as files, and are removed after the merge with `/rbb:clear`. Git history shows that the spec was not changed after approval. Or only on this machine (`none`): nothing of RBB reaches the repository. `.rbb/.gitignore` keeps every RBB file out of git, the pull request body carries the review, and a hash of each spec file is the evidence that the spec was not changed after approval.
- **Where its permission rules go**, so that only real decisions ask you (see [Permissions](#permissions)): the project's `.claude/settings.json`, which the team shares through git, or `.claude/settings.local.json`, for this machine only, or nowhere, in which case the rules are shown for you to add. RBB only adds allow rules, removes nothing, and never allows the commands that delete records or publish. Claude Code asks you once before the file is written, as it does for any change to its settings.

Then it reads the repository: the commit style and the branch naming of RBB's own commits are taken from your history, and the commit style is asked (Conventional Commits or plain subjects) only when the history is mixed. The test command is recognised from the files at the root (pytest with poetry or uv, npm and the other package managers, cargo, go, maven and gradle, make, dotnet) and asked with the recommended one first, so that the scout and the builder can run your tests without asking; you can type another, or allow none. Everything is kept in `.rbb/config.json`. Run `/rbb:setup` again at any time: it changes what you ask it to and adds only what is missing. The GitHub CLI, signed in, is needed only to post pull requests from inside RBB.

## A first session

The change below is illustrative. Your lines are marked `you`; the rest is what Claude Code says and does with RBB loaded.

```
you      /rbb Exporting an empty report crashes with a KeyError.
         It should produce a file with just the header row.

claude   [shapes the goal: the outcome, two examples, no constraints yet]

         One question only you can answer:
         Should an empty report also export when it has no columns?
           - Export an empty file (Recommended): the file exists, with no
             header, because there is no header to write.
           - Raise an error: a report with no columns is treated as invalid.
           Why the recommendation: the request asks for a file, and the
           example shows the header; with no columns there is nothing to
           show, and nothing says that is an error.
           What the answer changes elsewhere: the docstring of export().

you      Go with the recommendation. And don't change the export format
         for reports that have rows.

         [the goal is revised: your sentence becomes constraint 1, verbatim]

claude   [the scout explores the code: reproduces the KeyError, maps the
         callers and the tests, settles two decisions from the code;
         an advocate argues the other side of each; a planner groups
         the places to change into steps]

         [the spec page: Goal, Done when, Constraints, Out of scope,
         Reproduction, What the change touches, Decisions, Plan,
         What no example exercises, Examined, The request as written]

         Approve this spec?  [Approve]  [Change something]

you      Approve

         Approved as commit a41c9e7: the spec's files and its page,
         with the trailer RBB-Approved: empty-report-header.

claude   [the builder, from the frozen spec alone: runs both examples,
         sees the first fail, makes the smallest change, runs them
         again and the suite, logs one decision, commits]

         [the check: every change mapped to the item it serves, the
         builder's claims checked against the diff; the review page]

         [the pull request body, in your project's template]

         empty-report-header: checked: no differences from the spec,
         1 statement for a person to confirm. The pull request body is
         written; /rbb:pr empty-report-header post opens it.
```

From your request to the body, you were asked one question and one approval. If the check had found a difference, the review's Warnings table would show it in one row: the item, where, the reason, what was requested and what came out, and the body would list it in one line. Nothing blocks; you decide what to do with it.

## The flow

Each step is a command. The entry command's full name is `/rbb:rbb`, since a plugin's commands carry the plugin's name; Claude Code accepts `/rbb` for it as long as no other plugin has a command called `rbb`. Each one runs a workflow in the background and shows you its result; nothing happens in your conversation's own context.

| Command | What it does |
|---|---|
| `/rbb:rbb [request or change]` | Runs the whole flow: the goal, the spec and its approval, the build, the check, and the pull request body, stopping wherever a step asks you something. Given the name of a change that exists, resumes it from where it stands. With no argument, lists the changes in the repository with where each stands; with one change it resumes it, with several it asks which. After the approval it asks nothing. It never posts, pushes or deletes; posting stays `/rbb:pr <change> post` |
| `/rbb:goal <request>` | Restates your request as a goal with no solution in it: one sentence saying how the request was read, the outcome, examples of when it is done, constraints, what is out of scope. If a question can only be answered by you, it asks it with the real answers as the choices (including, when the question is who owns or chooses something, that nobody does), what each would mean for the change, the recommended one first, why that one rather than the others, and what the answer changes elsewhere. An answer in your own words is read back to you, and asked about when it could mean two things. Your answer stands and is recorded as yours. A request that names a fix is asked what the fix is for; a request holding several goals keeps one and splits off the rest. Saves `goal.json` and its page `goal.md` |
| `/rbb:approve <change>` | When no spec exists yet, explores the code first (a scout reproduces the problem, maps what the change touches and settles the decisions it can from the code) and drafts the spec with its plan. Then shows you the spec page and asks: approve, or change something. Your words go into the goal exactly as written, as a constraint, an example or an exclusion in your own words, so the check and the pull request hold them as your request, and the spec is drafted again. On approval, the spec is frozen: an approval commit in committed mode, a hash of each spec file in mode `none` |
| `/rbb:build <change>` | A builder that never saw your conversation works from the frozen spec alone. It runs each example before and after, makes the smallest change that passes them, logs every decision and every deviation from the plan, and the build is committed with its log. It stops, changing nothing, when an example already behaves as the spec says it should after the change. The commit takes the tracked files it changed and the new files it named as part of the change; a file its runs left behind stays in the tree, uncommitted, and is reported |
| `/rbb:check <change> [grouped\|per-hunk]` | Compares the change with the spec and its plan, and shows you the review page. Every changed place is accounted for: which item of the spec it serves, or that nothing asked for it. The builder's claims are checked last, against the diff |
| `/rbb:pr <change> [post]` | Commits the check and the review (committed mode), and writes the pull request body into your project's template: the goal, each change and where it is, each difference and each statement a person must confirm, the judgment calls, and a link to the review. It posts only when you ask, after one confirmation, with `gh` |
| `/rbb:status [change]` | Says where each change stands and what comes next, worked out from its record files and git: shaping the goal, spec drafted, approved, built, checked (with the counts), pull request body written, or merged and awaiting clearing. Changes nothing |
| `/rbb:clear [target]` | After the merge: lists each change whose records are in the target branch, asks which to clear and where the commit goes, and removes their folders in one commit. In mode `none`, deletes the local folders instead |
| `/rbb:setup` | Sets the repository up (above): where the records live, where the permission rules go and writes them, the commit style and branch naming from your history, the test command. Runs by itself the first time `/rbb`, `/rbb:goal` or `/rbb:approve` is used in a repository; run again, it changes what you ask and adds only what is missing |
| `/rbb:documents [committed\|none]` | Changes where the records live (above): the setup with the mode given |

## What you approve

The spec page, `.rbb/<change>/spec.md`, is generated by code from the record files, so what you read is exactly what was recorded. Its sections:

| Section | What it holds |
|---|---|
| How the request is read | One sentence saying how your request was taken: what the change belongs to and what it does not touch. It comes first because it is the sentence to disagree with: a wrong reading otherwise survives into the questions and the examples without ever being stated |
| Goal | The outcome, with no solution in it |
| Done when | Numbered examples: concrete inputs and results. New behaviour fails before the build; existing behaviour that must keep working passes before and after |
| Constraints | What must hold or must not change, in your words where they are yours |
| Out of scope | What was considered and left out |
| Agreed extras | What you agreed to beyond the request, and why. Only present when there is one |
| Reproduction | What the scout saw when it tried the failure: the outcome, what was observed and the cause, each marked observed or inferred, with the evidence |
| What the change touches | The code to change, every caller and dependent, the tests that cover it and those that assert the behaviour being changed, and the docs and config that describe it |
| Decisions | Judgment calls first, each in full: the choice, **why**, the **alternatives considered** (only real ones: an option that would break the goal, a constraint or an example is not an alternative) each with why it was not taken, **what could change this**, **decision by** (the model and effort that made it, and when) and **decided by** (what settled it: your answer, the goal, a constraint, the project's convention or the smallest change). Decisions with no credible alternative take one line each |
| Plan | The approach, then one row per step: what it does, which items it serves, and the files, lines and symbols it touches |
| What no example exercises | Ways the change could fail that none of the examples would catch, as short facts you should know before reading the change. They also appear on the review and in the pull request body |
| Found along the way, not part of this change | Defects the scout found off the path that meet the bar, each with evidence. Nothing is done about them here; they also appear on the review and in the pull request body |
| Examined | Every file read and command run while exploring. Left out of the page's reading length |
| The request as written | Your request, quoted, so nothing of it is lost in the restatement |

A spec carries at most four judgment calls; one that needs more is split into separate goals. Its prose stays under about 1,200 words, not counting the Examined list and the request.

Two agents that saw neither the decider's conversation nor its reasons work on the alternatives. An advocate reads the code and argues, for every decision, the best case for deciding otherwise; a case that holds is shown as an alternative "raised by an independent advocate", and a decision the scout had called settled becomes a judgment call. A reviewer then keeps only the options, the scout's and the advocate's, that a competent developer could defensibly have taken. Alternatives it dropped stay in the record files, never on the page.

## What the review shows

The review page, `.rbb/<change>/review.md`, is also generated by code: from the spec, the build log and the check. It shows what the check found and recommends nothing.

| Section | What it holds |
|---|---|
| The goal | As approved |
| What changed | Each changed place once, with the lines in the changed code and the item of the spec it serves |
| What no example exercises | The scout's review focus, repeated from the spec page: the ways the change could fail that no example would catch |
| Found along the way, not part of this change | The defects the scout found off the path, with evidence, repeated from the spec page so the reviewer knows they were seen and left alone |
| Warnings | First the count of differences from the approved spec, and how complete the check was. Then one row per difference: the item, where, the reason, what was requested, and what the outcome was. A difference is an example not met, a constraint violated, a change nothing asked for (even inside code that serves an item: a tidy-up nobody asked for serves nothing), a step of the plan not done, a change outside the plan (with the builder's logged reason when there is one), a claim the diff contradicts, or a build decision that conflicts with an approved one |
| Not verified | What the builder says and the change alone cannot show, such as a test run. The person who ran the build should confirm it |
| Decisions | The judgment calls of the spec and the builder's own, each in full, as on the spec page |

Only the goal, your words (constraints and agreed extras) or an approved decision put a change in scope. The plan's wording does not.

## The records

Everything RBB writes is under `.rbb/<change>/`. Each file is saved once, by the agent that wrote its content, and read back before it counts:

| File | Written by | Holds |
|---|---|---|
| `goal.json`, `goal.md` | the goal workflow | The goal and its page |
| `scout.json`, `scout-meta.json` | the scout; code | What the code exploration found: reproduction, impact, decisions, locations. The meta file holds what code added: the base commit, the model and effort that ran, which alternatives the review kept |
| `plan.json` | the planner | The steps, each grouping the scout's locations |
| `advocate.json` | the advocate | For each decision, the best case for deciding otherwise, with its evidence, or none |
| `spec.json`, `spec.md` | code | A manifest naming the files above, and the page |
| `approval.json` | code | Mode `none` only: the hash of each spec file at approval |
| `build.json`, `build-meta.json` | the builder; code | Evidence for each example before and after, decisions, deviations, claims; and what code added |
| `check.json`, `review.md` | code | The check's result, and the review page |
| `pr.md` | code | The pull request body |

The shape follows from a safeguard. Anthropic's models refuse to reproduce another agent's reasoning when asked to write it out, so nobody re-types what the scout, the planner or the builder wrote. Each saves its own work, and code adds its data in separate files. The pages combine everyone's reasoning, and the agent saving one may be refused. Then RBB saves the page without the reasoning instead (decisions one line each, with a note saying which files hold the reasons in full) and tells you. The record files are complete either way.

## Permissions

RBB runs as agents inside Claude Code, so each command they run is subject to your permission rules. Without rules, you are asked for every git command and every file write, and a workflow waits silently while the question is open. The aim is that only real decisions ask you: deleting records, and pushing or posting. The setup writes the rules below where you choose (see [Setting up](#setting-up)), and they are listed here so that you can see what each allows.

What RBB runs, and who:

| Who | Runs | Suggested rule |
|---|---|---|
| `/rbb:rbb` | RBB's own skills, through the `Skill` tool | `Skill` |
| The workflows | the `Workflow` tool with the plugin's workflows, whose names differ from the commands' on purpose: Claude Code lists every workflow as a command too, and one named like a command would take its place | `Workflow(rbb:shape-goal)`, `Workflow(rbb:scout)`, `Workflow(rbb:specify)`, `Workflow(rbb:configure)`, `Workflow(rbb:freeze-spec)`, `Workflow(rbb:build-change)`, `Workflow(rbb:check-change)`, `Workflow(rbb:write-pr)`, `Workflow(rbb:clear-records)`, `Workflow(rbb:derive-status)` |
| Read-only agents | git commands that read: `status`, `log`, `show`, `diff`, `rev-parse`, `hash-object`, `ls-files`, `ls-tree`, `cat-file`, `branch --list`, `symbolic-ref`, `remote`, `check-ignore`, and `git -c core.quotepath=false` before some of them | `Bash(git status:*)`, `Bash(git log:*)`, `Bash(git show:*)`, `Bash(git diff:*)`, `Bash(git rev-parse:*)`, `Bash(git hash-object:*)`, `Bash(git ls-files:*)`, `Bash(git ls-tree:*)`, `Bash(git cat-file:*)`, `Bash(git branch:*)`, `Bash(git symbolic-ref:*)`, `Bash(git remote:*)`, `Bash(git check-ignore:*)`, `Bash(git -c:*)` |
| The committer | `git add` and `git commit`, exactly the commands the workflow wrote | `Bash(git add:*)`, `Bash(git commit:*)` |
| The status and the setup | `tail -v` on the small record files and the settings files, `grep` on each `check.json` and on the `Makefile`, to read them without an agent copying them | `Bash(tail:*)`, `Bash(grep:*)` |
| The scout and the builder | your project's own commands: reproducing the problem, running the examples and the test suite | The test command you chose at setup, for example `Bash(poetry run pytest:*)` |
| The scout, the builder and the recorder | reading, writing and editing files in the repository | Allow edits in the project folder, or run in the accept-edits mode |

Leave these asking, since they are the decisions:

| Command | When |
|---|---|
| `git rm`, `git clean` | `/rbb:clear`, deleting records |
| `git switch -c`, `git push`, `gh pr create`, `gh pr edit` | `/rbb:pr post`, publishing |

The setup appends the rules to `permissions.allow` in the file you chose, `.claude/settings.json` (shared with the team through git) or `.claude/settings.local.json` (this machine only), and changes nothing else in it: the file is read, the rules it or the other file already holds are skipped, and the result is written and read back. A file that is not valid JSON is left alone, and the rules are shown instead. Claude Code asks before an agent writes one of its settings files, and in auto mode it refuses without asking. When the write does not happen, the setup gives you a command for your shell that writes the same file, the rules added and nothing else changed, to run if you choose; the desktop app puts a Run button on it. If you chose to keep the rules out of both files, the setup shows the list instead. `/rbb:setup` adds whatever is missing whenever you run it again.

RBB's commands are written so these rules match: the committer runs each command exactly as the workflow wrote it, never through `cd`, `git -C` or a chain.

## When something goes wrong

| Situation | What happens, and what to do |
|---|---|
| A command waits, and nothing happens | A permission question is open, or a tool that holds destructive commands (such as a Blast Radius pane) is waiting for Proceed or Cancel. The agent running the command cannot report back until it is answered, and RBB cannot tell a hold from a long step. Answer it. On Cancel, or when nobody answers within the tool's limit, the workflow stops and names the command it was not allowed to run |
| A workflow stops naming a command it was not allowed to run | Run `/rbb:setup` again, which adds the rules that are missing (see Permissions), or allow the command yourself, and run the step again. Nothing was half done: every step verifies its result from git before it reports |
| A workflow is refused before it starts: "script contains control characters that would be hidden in the approval dialog" | The plugin's files have Windows line endings, which happens when the marketplace clone was made on Windows with `core.autocrlf=true` before release 0.1.3 shipped the `.gitattributes` that pins them. Remove the marketplace and add it again (`claude plugin marketplace remove rbb`, then the two install commands above), so that the clone is fresh; updating it in place leaves the files it already has unchanged. A copy loaded with `--plugin-dir` has the same cure: clone it again |
| "the two relays of git facts disagreed" | Each git fact is read by two agents whose outputs must match. Run the step again |
| The approval says the code moved since it was explored | The plan's lines refer to the commit the scout explored. `/rbb:approve` explores and drafts again |
| The build refuses: the working tree has changes outside `.rbb` | Commit or stash them, so that every change after this point is the build |
| The build reports files it left untracked | The builder's runs left a file behind (a script, an output), and RBB never deletes anything on its own. Delete it, or add it to the change yourself |
| The builder stopped without changing anything | An example of new behaviour already passed, or an example of existing behaviour failed, before the build. The spec or the example is wrong; change it with `/rbb:approve` |
| The build, the check or the pull request says the spec changed after approval (mode `none`) | A spec file no longer has its approved hash. Approve again, or restore the file |
| A step says a record could not be saved | The agent saving it was refused (Anthropic's safeguard against reproducing reasoning, billed and not retried by RBB), or the read-back did not match. Run the step again; its author writes the file anew |
| A page says the reasons were left off | The full page's save was refused; the page without the reasoning was saved instead. The record files named on the page hold the reasons in full |
| `/rbb:pr` refuses: the check does not cover the current code | Run `/rbb:check` again. `/rbb:status` says which changes are in this state |
| `/rbb:pr` cannot post | `gh` is missing or not signed in, or the repository has no GitHub remote. The commands to run yourself are shown |
| `/rbb:clear` finds nothing | No change's records are in the target branch's tree. Records of a change still open stay until it is merged |
| The check's verdict is "error" | The check could not complete, and the review says why. Nothing below its first line has been checked |

## Questions

**Does the model see the spec?** Yes. The builder reads the frozen spec, and nothing else of your conversation. The checker reads the spec, the diff and the build log, and never the builder's conversation.

**Why are the pages generated by code?** So that what you approve is exactly what was recorded, and what the reviewer reads is exactly what was checked. No model rewrites them.

**Can the check block a merge?** No. It presents differences; the decision stays with the people. What is enforced is that `/rbb:pr` writes no body until a check covers the current code.

**What does it cost?** Each step runs several agents, most of them small (reading a file, running a git command). The builder and the scout are the long ones. Every refused save is billed, which is why RBB never retries one.
