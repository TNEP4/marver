---
kind: record
audience: team
---

# Shipped - what runs where, and what is available to whom

The only file that says what is available. Every evidence cell carries its level, and `confirmed`
and `reported` carry a citation:

- `confirmed` - observed in a system of record: the deploy run whose deploy step succeeded for that
  service, a ci run that executed the suite. An environment marked "deployed" is not proof on its
  own - some pipelines mark it when the run stood down.
- `reported` - a written claim, cited: a changelog line, an ops note.
- `unknown` - neither, with the reason. An honest unknown is the right answer.

Commit ancestry says a change is inside a revision, not that the revision is running.

## Services × environments

| Service | Environment | Revision | Deployed at | How | Evidence |
|---|---|---|---|---|---|
| app | production | - | - | - | `unknown` - nothing recorded yet |

## Capabilities

| Capability | Implemented | Verified | Available | Contract |
|---|---|---|---|---|
