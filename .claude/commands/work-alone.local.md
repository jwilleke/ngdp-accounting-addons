# /work-alone — repo-specific additions

Read with `work-alone.md`; these rules are part of the command in this repository.

## Reviewing and clearing the log

`private/agent-work-alone.md` is a to-do list for the operator, not a history. After a run:

1. Go through the session with the operator one item at a time: answer each __Stuck__ item, review
   each __Decision made without the operator__, and review each __Other abnormality__.
2. Record any decision that comes out of it in `docs/plans/decisions.md` and on the related issue.
3. When every item is handled, clear the file back to the empty skeleton (the header and the
   `SESSIONS:START` / `SESSIONS:END` markers). The issues, PRs and decisions log are the durable
   record.

Because the file is cleared after each review, a new run starts with no earlier sessions to check
for duplicates; search the issues instead.
