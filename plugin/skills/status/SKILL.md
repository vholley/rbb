---
name: status
description: Say where each RBB change in this repository stands (goal, spec, approved, built, checked, pull request, merged) and what comes next, worked out from its record files and git. Changes nothing.
argument-hint: [change]
---

Arguments: $ARGUMENTS

1. Run the plugin workflow `rbb:derive-status` with the Workflow tool, with args `{"change": "<the first argument>"}`, leaving `change` out when there is no argument, and wait. Do not read the record files yourself.
2. If it returned an error, show it as written and stop.
3. Show each line of `lines` exactly as written, one per change. If `lines` is empty, say what `note` says. Add nothing of your own: no summary, no advice beyond the line's own "next".
