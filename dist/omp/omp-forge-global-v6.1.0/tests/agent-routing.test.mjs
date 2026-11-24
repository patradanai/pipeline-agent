import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_ASSIGNMENTS, cloneAgentAssignments, requiredAgentsFor,
  initialState, phaseInstruction, parseCommand, formatAgentAssignments,
  agentNameFor, routeAgentNames,
  listAssignedAgentNames,
} from '../forge/core.mjs';

test('default Forge agents: plan critic only with plan review on, QA reviewer only before PASS', () => {
  const s=initialState('Build a scheduling service','forge-roles');
  assert.deepEqual(listAssignedAgentNames(DEFAULT_AGENT_ASSIGNMENTS),['forge-plan-critic','forge-code-reviewer']);
  assert.equal(s.planReview,false);
  assert.deepEqual(requiredAgentsFor(s),[]);
  const reviewed=initialState('Build a scheduling service','forge-roles',null,null,{},{planReview:true});
  assert.deepEqual(requiredAgentsFor(reviewed),['forge-plan-critic']);
  assert.match(phaseInstruction(reviewed),/PLAN REVIEW is ON[\s\S]*`forge-plan-critic` ONCE/);
  assert.doesNotMatch(phaseInstruction(s),/PLAN REVIEW is ON/);
  // Legacy v6.0 states may still carry requirementStep; it never widens the gate.
  assert.deepEqual(requiredAgentsFor({...s,requirementStep:'COOKING'}),[]);
  assert.deepEqual(requiredAgentsFor({...s,phase:'EXECUTE'}),[]);
  assert.deepEqual(requiredAgentsFor({...reviewed,phase:'EXECUTE'}),[]);
  assert.deepEqual(requiredAgentsFor({...s,phase:'QA'}),['forge-code-reviewer']);
  assert.deepEqual(requiredAgentsFor({...s,phase:'QA',qaStatus:'FAIL'}),['forge-code-reviewer']);
  assert.deepEqual(requiredAgentsFor({...s,phase:'QA',qaStatus:'PASS'}),[]);
  assert.doesNotMatch(phaseInstruction(s),/forge-planner|forge-requirement/);
});

test('legacy workflow snapshots keep a custom reviewer and drop retired gates',()=>{
  const prior={...cloneAgentAssignments(),planning:{planner:'my-old-planner'}};
  prior.qa.reviewer='my-reviewer';
  const s=initialState('Build feature','forge-legacy',prior);
  assert.deepEqual(s.agentAssignments.planning,{critic:'forge-plan-critic'}); // retired planner slot dropped
  assert.deepEqual(requiredAgentsFor({...s,phase:'QA'}),['my-reviewer']);
  assert.equal(agentNameFor(s,'qa','reviewer'),'my-reviewer');
  assert.match(routeAgentNames('Call forge-code-reviewer',s),/my-reviewer/);
});

test('new workflow defaults to fixed OMP agents',()=>{
  const s=initialState('Build feature','forge-fixed');
  assert.deepEqual(s.agentAssignments,cloneAgentAssignments());
  assert.match(formatAgentAssignments(DEFAULT_AGENT_ASSIGNMENTS),/forge-code-reviewer/);
  assert.doesNotMatch(formatAgentAssignments(DEFAULT_AGENT_ASSIGNMENTS),/forge-planner|forge-executor|forge-delivery/);
});

test('deprecated assignment commands are NOT reinterpreted as requirements',()=>{
  assert.deepEqual(parseCommand('agents'),{type:'agents'});
  assert.deepEqual(parseCommand('agent'),{type:'agentHelp'});
  assert.deepEqual(parseCommand('agent set qa forge-code-reviewer new-reviewer'),{type:'agentHelp'});
  assert.deepEqual(parseCommand('agent reset all'),{type:'agentHelp'});
});
