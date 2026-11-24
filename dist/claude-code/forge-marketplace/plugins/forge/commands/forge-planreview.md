---
description: Forge · Turn the optional plan critic (review before approval) on or off
argument-hint: [on|off]
disable-model-invocation: true
---
The user ran `/forge-planreview $ARGUMENTS`.

The Forge plugin hook has already processed this command and attached its result as context that starts with "Forge" or "[FORGE".

- If Forge attached a gate instruction, follow it exactly, starting now.
- If Forge attached only a status or message, show it to the user verbatim and stop.
- If no Forge context is present, tell the user the Forge hook did not run (check `/hooks`, and that `node` 22+ is on PATH) and do nothing else.
