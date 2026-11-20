import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { calculateAge } from './age-calculator.mjs';

const script = new URL('./age-calculator.mjs', import.meta.url);
const invalidMessage = 'วันเกิดไม่ถูกต้อง: กรุณาใช้วันที่จริงในรูปแบบ YYYY-MM-DD';
const futureMessage = 'วันเกิดต้องไม่อยู่ในอนาคต';
const usageMessage = 'วิธีใช้: node examples/age-calculator.mjs YYYY-MM-DD';

function runCli(args) {
  return spawnSync(process.execPath, [script.pathname, ...args], { encoding: 'utf8' });
}

function formatLocalDate(date) {
  const year = String(date.getFullYear()).padStart(4, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

test('calculates completed years around an ordinary birthday', () => {
  assert.equal(calculateAge('2000-11-21', '2026-11-20'), 25);
  assert.equal(calculateAge('2000-11-21', '2026-11-21'), 26);
  assert.equal(calculateAge('2000-11-21', '2026-11-22'), 26);
});

test('returns zero on birth date', () => {
  assert.equal(calculateAge('2026-11-20', '2026-11-20'), 0);
});

test('uses March 1 anniversary for February 29 birthdays in non-leap years', () => {
  assert.equal(calculateAge('2000-02-29', '2025-02-28'), 24);
  assert.equal(calculateAge('2000-02-29', '2025-03-01'), 25);
  assert.equal(calculateAge('2000-02-29', '2024-02-28'), 23);
  assert.equal(calculateAge('2000-02-29', '2024-02-29'), 24);
});

test('rejects malformed and impossible birth or reference dates', () => {
  for (const [birth, reference] of [
    ['31/12/2000', '2026-11-20'],
    ['2025-02-29', '2026-11-20'],
    ['2025-13-01', '2026-11-20'],
    ['0000-01-01', '2026-11-20'],
    ['2000-01-01', '2025-02-29'],
    ['2000-01-01', '2026-1-01'],
  ]) {
    assert.throws(() => calculateAge(birth, reference), TypeError);
  }
});

test('rejects birth dates after reference date', () => {
  assert.throws(() => calculateAge('2026-11-21', '2026-11-20'), RangeError);
});

test('CLI prints exact age for yesterday in local calendar time', () => {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const result = runCli([formatLocalDate(yesterday)]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'อายุ: 0 ปี\n');
  assert.equal(result.stderr, '');
});

test('CLI reports missing and extra arguments exactly', () => {
  for (const args of [[], ['2000-01-01', 'extra']]) {
    const result = runCli(args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${usageMessage}\n`);
  }
});

test('CLI rejects malformed and impossible dates exactly', () => {
  for (const birthDate of ['31/12/2000', '2025-02-29', '2025-13-01']) {
    const result = runCli([birthDate]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, `${invalidMessage}\n`);
  }
});

test('CLI rejects a future local birth date exactly', () => {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const result = runCli([formatLocalDate(tomorrow)]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, `${futureMessage}\n`);
});
