import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_AGENT_ASSIGNMENTS, cloneAgentAssignments, requiredAgentsFor,
  initialState, phaseInstruction, parseCommand, formatAgentAssignments,
  agentNameFor, routeAgentNames,
} from '../forge/core.mjs';

test('default Forge agents remain separate for each internal requirement and QA step', () => {
  const s=initialState('Build a scheduling service','forge-roles');
  assert.deepEqual(requiredAgentsFor(s),['forge-requirement']);
  assert.deepEqual(requiredAgentsFor({...s,requirementStep:'COOKING'}),[
    'forge-requirement','forge-critic','forge-architect','forge-qa-strategist']);
  assert.deepEqual(requiredAgentsFor({...s,requirementStep:'CHALLENGE'}),['forge-critic','forge-architect']);
  assert.deepEqual(requiredAgentsFor({...s,phase:'QA_REVIEW'}),['forge-qa','forge-code-reviewer']);
  assert.deepEqual(requiredAgentsFor({...s,phase:'DELIVERY_PREP'}),['forge-delivery']);
  assert.match(phaseInstruction({...s,phase:'PLANNING'}),/forge-planner/);
});

test('legacy workflow snapshots can still resume with their original agents',()=>{
  const prior=cloneAgentAssignments();
  prior.planning.planner='my-old-planner';
  const s=initialState('Build feature','forge-legacy',prior);
  assert.deepEqual(requiredAgentsFor({...s,phase:'PLANNING'}),['my-old-planner']);
  assert.equal(agentNameFor(s,'planning','planner'),'my-old-planner');
  assert.match(routeAgentNames('Call forge-planner',s),/my-old-planner/);
});

test('new workflow defaults to fixed OMP agents',()=>{
  const s=initialState('Build feature','forge-fixed');
  assert.deepEqual(s.agentAssignments,cloneAgentAssignments());
  assert.match(formatAgentAssignments(DEFAULT_AGENT_ASSIGNMENTS),/forge-planner/);
});

test('deprecated assignment commands are NOT reinterpreted as requirements',()=>{
  assert.deepEqual(parseCommand('agents'),{type:'agents'});
  assert.deepEqual(parseCommand('agent'),{type:'agentHelp'});
  assert.deepEqual(parseCommand('agent set qa forge-code-reviewer new-reviewer'),{type:'agentHelp'});
  assert.deepEqual(parseCommand('agent reset all'),{type:'agentHelp'});
});
