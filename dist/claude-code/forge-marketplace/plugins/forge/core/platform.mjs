/**
 * Platform wording for Forge instructions.
 *
 * core.mjs renders instructions in OMP wording (the original platform), which
 * keeps the OMP adapter byte-for-byte stable. Other adapters translate the few
 * platform-specific sentences here. tests/platform.test.mjs renders every
 * gate and fails if any OMP-only concept leaks into another platform's text.
 */

const CC_PLAN_SUBMIT = 'Claude Code submission: make sure the session is in plan mode (call EnterPlanMode, or ask the user to press Shift+Tab until plan mode is shown). Write the COMPLETE plan to the plan file Claude Code assigns in plan mode (or pass it as the `plan` argument), then call ExitPlanMode. Forge checks the plan contract before Claude Code shows the approval prompt; if Forge denies the call, fix the listed issues and call ExitPlanMode again. Do not implement or self-approve.';

// Order matters: span rules run before the generic local:// and tool-name rules.
const CLAUDE_CODE_RULES = [
  [/\nHashline edit: [^\n]*/g, ''],
  [/Forge runs its own plan mode: a read-only safety boundary holds until the human approves the plan in Forge's approval dialog\./g,
    'Forge enforces a read-only safety boundary until the human approves the plan through Claude Code\'s native plan approval.'],
  [/\[OMP FORGE/g, '[FORGE'],
  [/Submit the plan for approval only after writing a real local:\/\/ plan file[^\n]*?only the human can approve\./g,
    'Submit the plan for human approval only through Claude Code\'s native plan approval: call ExitPlanMode with the complete plan text while in plan mode. Forge validates the plan contract before the approval prompt opens.'],
  [/The only writable file is Forge's plan file local:\/\/[A-Za-z0-9._-]+-plan\.md[^\n]*?NEVER defer all writing to the end\./g,
    'The only writable file is the plan file Claude Code assigns in plan mode (call EnterPlanMode first, or ask the user to press Shift+Tab until plan mode is shown): write it early and update it as you learn; NEVER defer all writing to the end.'],
  [/Approval: call forge_plan_propose after a successful plan write;[^\n]*?Forge opens its approval dialog\./g,
    'Approval: call ExitPlanMode with the complete plan; Forge checks the plan contract before Claude Code shows the approval prompt. NEVER ask the user to approve in prose or with AskUserQuestion. If Forge denies the call, fix the listed issues and call ExitPlanMode again.'],
  [/\[GATE 1\/3: FORGE PLAN APPROVAL\][\s\S]*?Do not finish with just a textual 'ready' response\./g,
    `[GATE 1/3: NATIVE PLAN APPROVAL]\n${CC_PLAN_SUBMIT}`],
  [/Forge PLAN owns rework drafting\.[^\n]*?change modes\./g,
    'Forge planning owns rework drafting. Use Claude Code plan mode for the revision; the platform opens native approval only after the plan is ready. Do not ask the user to change modes.'],
  [/After a successful rework-plan write, call forge_plan_propose; Forge opens the human approval dialog when this turn ends\. Do not ask the user to submit or advance a gate\./g,
    'After a successful revision, submit the complete revised plan once with ExitPlanMode to open human approval. Do not ask the user to advance the gate.'],
  [/Save a revised plan to local:\/\/[A-Za-z0-9._-]+-plan\.md; never overwrite the previous approved plan\./g,
    'Write the revised plan to the native plan file; preserve the previously approved plan as the rework baseline.'],
  [/local:\/\/[A-Za-z0-9._-]+-plan\.md/g, 'the approved plan'],
  [/`scout` subagents/g, 'Explore subagents'],
  [/the native ask tool/g, 'AskUserQuestion'],
  [/via native task/g, 'via the Agent tool'],
  [/through native task/g, 'through the Agent tool'],
  [/through the native task tool/g, 'through the Agent tool'],
  [/the native task tool/g, 'the Agent tool'],
  [/native task/g, 'Agent tool'],
  [/forge_plan_propose/g, 'ExitPlanMode'],
  [/OMP's /g, 'Claude Code\'s '],
  [/\bOMP\b/g, 'Claude Code'],
];

export const PLATFORMS = Object.freeze(['omp', 'claude-code']);

/** Translate an instruction rendered in OMP wording to the target platform. */
export function adaptInstruction(text, platform = 'omp') {
  if (platform === 'omp' || text == null) return text;
  if (platform !== 'claude-code') throw new Error(`Unknown Forge platform: ${platform}`);
  let out = String(text);
  for (const [pattern, replacement] of CLAUDE_CODE_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** OMP-only concepts that must never appear in another platform's instructions. */
export const OMP_ONLY_PATTERN = /local:\/\/|xd:\/\/|\bOMP\b|native task|native ask tool|forge_plan_propose|`scout`|Hashline edit:/;
