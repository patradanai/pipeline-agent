import test from 'node:test';
import assert from 'node:assert/strict';
import { renderForgeWidget } from '../forge/core.mjs';

const cases = [
  ['PLAN', 'Planning', '1/3', '▰▱▱'],
  ['EXECUTE', 'Execution', '2/3', '▰▰▱'],
  ['QA', 'QA review', '3/3', '▰▰▰'],
];
for (const [phase, title, fraction, meter] of cases) {
  test(`compact widget: ${phase} renders one line without future gates`, () => {
    const result = renderForgeWidget({phase, active:true});
    assert.equal(result.length, 1);
    assert.match(result[0], new RegExp(title));
    assert.match(result[0], new RegExp(fraction.replace('/', '\\/')));
    assert.doesNotMatch(result[0], /AWAITING|APPROVAL|○|DISCOVERY|COOKING|CHALLENGE/);
    assert.ok(result[0].includes(meter), result[0]);
  });
}
test('Forge review shows Plan review status only for a valid written unapproved plan', () => {
  assert.deepEqual(renderForgeWidget({phase:'PLAN',active:true,planWritten:true,planValid:true,approved:false}), ['FORGE  ▰▱▱  Plan review  1/3']);
  for (const state of [
    {planWritten:false,planValid:true,approved:false},
    {planWritten:true,planValid:false,approved:false},
    {planWritten:true,planValid:true,approved:true},
  ]) {
    assert.match(renderForgeWidget({phase:'PLAN',active:true,...state})[0], /Planning/);
  }
});
test('QA delivery is displayed only after PASS', () => {
  for (const qaStatus of ['FAIL','BLOCKED','pending']) {
    assert.match(renderForgeWidget({phase:'QA',active:true,qaStatus})[0], /QA review/);
  }
  assert.match(renderForgeWidget({phase:'QA',active:true,qaStatus:'PASS'})[0], /Delivery/);
  assert.match(renderForgeWidget({phase:'QA',active:true,qaStatus:'BLOCKED',qaEvidencePending:true})[0], /QA evidence needed/);
});
test('completion removes persistent widget', () => {
  assert.equal(renderForgeWidget({phase:'QA',qaStatus:'PASS',active:false}),null);
  assert.equal(renderForgeWidget(null),null);
});
test('QA rework shows revision without approval noise', () => {
  assert.deepEqual(renderForgeWidget({phase:'PLAN',active:true,reworkCycles:2}),
    ['FORGE  ▰▱▱  Planning  1/3  ·  Rework 2']);
});
test('inactive and unknown gates do not show a widget', () => {
  assert.equal(renderForgeWidget({phase:'EXECUTE',active:false}),null);
  assert.equal(renderForgeWidget({phase:'UNKNOWN',active:true}),null);
  assert.equal(renderForgeWidget({phase:'REQUIREMENT',active:true}),null);
});
