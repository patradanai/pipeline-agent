#!/usr/bin/env node
/**
 * Forge — Claude Code MCP server (stdio, JSON-RPC 2.0, newline-delimited).
 * It only declares the Forge tool schemas. Validation and every state change
 * happen in the plugin's PreToolUse/PostToolUse hooks, which know the session.
 * The tools never touch project files.
 */
import { createInterface } from 'node:readline';

const severity = { type: 'string', enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] };
const qaStatus = { type: 'string', enum: ['PASS', 'FAIL', 'BLOCKED', 'NOT_RUN'] };
const str = { type: 'string' };
const strList = { type: 'array', items: str };

export const TOOLS = [
  {
    name: 'forge_qa_scope',
    description: 'Read-only Git HEAD/status/diff file inventory for approved QA. Does not edit, stage or commit files. A clean diff is not an automatic PASS.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: 'forge_qa_submit',
    description: 'Submit evidence-backed post-execution QA results grouped by the BIZ IDs in the approved plan. Forge computes the gate and saves the report outside the project. Only valid during Forge QA.',
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['topicResults', 'codeQualityChecks', 'codeReview'],
      properties: {
        topicResults: { type: 'array', items: { type: 'object', required: ['topicId', 'tests'], properties: {
          topicId: str,
          tests: { type: 'array', items: { type: 'object', required: ['testId', 'requirementIds', 'scenario', 'expected', 'actual', 'status', 'evidence', 'severity'], properties: {
            testId: str, requirementIds: strList, scenario: str, expected: str, actual: str, status: qaStatus, evidence: str, severity, fileRefs: strList,
          } } },
        } } },
        codeQualityChecks: { type: 'array', items: { type: 'object', required: ['gateId', 'name', 'status', 'evidence'], properties: { gateId: str, name: str, status: qaStatus, evidence: str } } },
        codeReview: { type: 'object', required: ['status', 'evidence', 'findings'], properties: {
          status: qaStatus, evidence: str,
          findings: { type: 'array', items: { type: 'object', required: ['id', 'title', 'severity', 'evidence'], properties: { id: str, title: str, severity, evidence: str, fileRefs: strList } } },
        } },
        reviewedChanges: strList, limitations: strList,
      },
    },
  },
  {
    name: 'forge_delivery_submit',
    description: "After QA PASS: submit the Conventional Commit subject/body and delivery highlights. subject: '<type>(<scope>): <summary>', at most 72 characters; the delivery instruction lists the allowed types. Forge saves delivery.md and commit-message.txt outside the project. No git command is run.",
    inputSchema: {
      type: 'object', additionalProperties: false, required: ['subject'],
      properties: { subject: str, body: str, highlights: strList, changedFiles: strList },
    },
  },
];

const send = msg => process.stdout.write(JSON.stringify(msg) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

export function handle(msg) {
  const { id, method, params } = msg ?? {};
  if (method === 'initialize') {
    return { jsonrpc: '2.0', id, result: {
      protocolVersion: typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: "6.1.0" },
      instructions: 'Forge workflow tools. Call them only when a Forge gate instruction says so.',
    } };
  }
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  if (method === 'tools/call') {
    const name = params?.name;
    if (!TOOLS.some(t => t.name === name)) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Forge received ${name}. The Forge hook validates it and attaches the gate result as context next to this tool result. If no "Forge" context follows, the Forge hooks are not running: tell the user to check /hooks.` }] } };
  }
  if (id === undefined || id === null) return null; // notification
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return fail(null, -32700, 'Parse error'); }
    const res = handle(msg);
    if (res) send(res);
  });
}
