import test from 'node:test';
import assert from 'node:assert/strict';
import { renderForgeWidget } from '../forge/core.mjs';

const cases = [
  ['REQUIREMENT', 'Requirement', '1/5'],
  ['PLANNING', 'Planning', '2/5'],
  ['EXECUTING', 'Execution', '3/5'],
  ['QA_REVIEW', 'QA review', '4/5'],
  ['DELIVERY_PREP', 'Delivery', '5/5'],
];
for (const [phase, title, fraction] of cases) {
  test(`compact widget: ${phase} renders one line without future gates`, () => {
    const result = renderForgeWidget({phase, active:true});
    assert.equal(result.length, 1);
    assert.match(result[0], new RegExp(title));
    assert.match(result[0], new RegExp(fraction.replace('/', '\\/')));
    assert.doesNotMatch(result[0], /AWAITING|APPROVAL|○|DISCOVERY|COOKING|CHALLENGE/);
    assert.match(result[0], /▰/);
  });
}
test('native proposal/review own the screen and hide widget', () => {
  for (const phase of ['PROPOSAL','AWAITING_APPROVAL']) {
    assert.equal(renderForgeWidget({phase,active:true}), null);
  }
});
test('delivery completion removes persistent widget', () => {
  assert.equal(renderForgeWidget({phase:'DELIVERY',active:false}),null);
  assert.equal(renderForgeWidget(null),null);
});
test('QA rework shows revision without approval noise', () => {
  assert.deepEqual(renderForgeWidget({phase:'REWORK_PLANNING',active:true,reworkCycles:2}),
    ['FORGE  ▰▰▱▱▱  Planning  2/5  ·  Rework 2']);
});
test('blocked gate shows concise actionable status', () => {
  for (const phase of ['PLAN_MODE_BLOCKED','AGENTS_BLOCKED','EXECUTION_BLOCKED','DELIVERY_BLOCKED']) {
    assert.deepEqual(renderForgeWidget({phase,active:false}), ['FORGE  ·  Attention needed  ·  /forge status']);
  }
});
