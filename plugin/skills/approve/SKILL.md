---
name: approve
description: Show the requester the drafted RBB spec and ask them to approve it or say what to change. Drafts the spec first when there is none. On approval, make the approval commit that freezes the spec.
argument-hint: <change>
---

The change: $ARGUMENTS

1. If `.rbb/<change>/spec.json` does not exist, run the plugin workflow `rbb:scout` with args `{"change": "<change>"}` and wait: it explores the code and then drafts the spec itself, in one run. If it returns an error, or its `spec` has an error, show it as written and stop. If it returned `questions`, the scout needs the requester: ask them as the goal skill asks its questions, then run the plugin workflow `rbb:shape-goal` with the answers as that skill does, and run `rbb:scout` again. Then say in one line how long each took, from `took` and `spec.took`: the `scout`, `advocate`, `review` and `planner` seconds, as minutes and seconds; leave out a value that is null.
2. Show the requester `.rbb/<change>/spec.md`. If it does not exist, say that the spec's page could not be saved, and that the spec is in the files `.rbb/<change>/spec.json` names, which they can read and approve from.
3. Ask with `AskUserQuestion`: "Approve this spec?" with the options "Approve" and "Change something". Never ask them to restate the change.
4. On "Approve":
   1. If `.rbb/config.json` does not exist, the repository is not set up: invoke the skill `rbb:setup` with the Skill tool and no argument, and let it ask and report as it does. Continue only once it has reported, and stop if it reported an error.
   2. Run the plugin workflow `rbb:freeze-spec` with args `{"change": "<change>"}` and wait. Report the commit it made, or its error as written. If it returned `hashes` instead (records kept only on this machine), show them and say they are what freeze the spec: the build, the check and the pull request refuse a spec whose files have any other hash.
5. On "Change something": take their words exactly as written. Run the plugin workflow `rbb:shape-goal` with args `{"change": "<change>", "request": "<the source request from goal.json>", "answers": [{"question": "What should change in the spec?", "answer": "<their words>"}]}`, then `rbb:scout` with `{"change": "<change>"}`, and go back to step 2.
6. If the approval reports that the code moved since it was explored, run `rbb:scout` again, and go back to step 2.
