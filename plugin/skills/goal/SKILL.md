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
6. If the workflow returned questions, ask them in one `AskUserQuestion` call, one question each, as written. Its options are the question's `options`, the recommended one first and labelled "(Recommended)"; each option's description is its `means`, and the recommended one's description adds the `because` and, when not empty, the `affects`, so the reason for the recommendation against the others is in front of the requester as they choose. Then run the workflow again with args `{"change", "request", "answers": [{"question", "answer"}]}`, and go back to step 5. An answer stands; never ask it again.
7. Never ask how to build anything.
8. When no questions remain, say that the goal is ready, and where it is saved.
9. If the goal lists goals that were split off, say that each becomes its own change, and offer to shape the first one with `/rbb:goal`.
