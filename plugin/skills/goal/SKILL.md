---
name: goal
description: Shape a request into an RBB goal - the outcome with no solution in it, examples, constraints and exclusions - and settle any question only the requester can answer. Saves .rbb/<change>/goal.json and goal.md.
argument-hint: <the request>
---

The request: $ARGUMENTS

1. If there is no request, ask for it. Wait.
2. If `.rbb/config.json` does not exist, the repository is not set up: invoke the skill `rbb:setup` with the Skill tool and no argument, and let it ask and report as it does. Continue only once it has reported, and stop if it reported an error.
3. Choose a change name from the request: at most five lowercase words joined by hyphens.
4. Run the plugin workflow `rbb:shape-goal` with the Workflow tool, with args `{"change": "<the name>", "request": "<the request, verbatim>"}`. Wait for it to finish.
5. Show the requester `.rbb/<change>/goal.md`.
6. If the workflow returned questions, first say what each one refers to: quote from the goal page the example, constraint or exclusion it concerns, or the words of the request it turns on, so that the requester sees the thing before the question about it. Then ask them in one `AskUserQuestion` call, one question each, as written. Its options are the question's `options`, the recommended one first and labelled "(Recommended)"; each option's description is its `means`, and the recommended one's description adds the `because` and, when not empty, the `affects`, so the reason for the recommendation against the others is in front of the requester as they choose. Then run the workflow again with args `{"change", "request", "answers": [{"question", "answer"}]}`, and go back to step 5. An answer is the requester's words alone, the option they chose or what they typed: never add a sentence of your own to it, however useful it seems. An answer stands; never ask it again.
7. Never ask how to build anything.
8. When no questions remain, state the goal's `reading` from `goal.json` as written, say that the goal is ready, and where it is saved. The reading is the sentence to disagree with if the request was taken wrongly; their correction, if any, goes to the workflow as an answer to the question "How should the request be read?", in their words. Their answers are recorded as written under the request on the goal page; the goal's items restate them.
9. If the goal lists goals that were split off, say that each becomes its own change, and offer to shape the first one with `/rbb:goal`.
10. End with the next step, one line: `/rbb:approve <change>` explores the code, drafts the spec and asks for approval. If the workflow returned an error, show it as written and say that `/rbb:goal` with the request runs it again.
