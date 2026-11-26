import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatFullName, normalizeNamePrefix } from './name-prefix.mjs';

const invalidPrefixMessage = 'คำนำหน้าชื่อไม่ถูกต้อง: ใช้ นาย, นาง, นางสาว, เด็กชาย, เด็กหญิง, Mr, Mrs, Ms หรือ Miss';
const invalidNameMessage = 'ชื่อหรือนามสกุลไม่ถูกต้อง: ต้องเป็นข้อความที่ไม่ว่าง';

test('keeps canonical Thai titles unchanged', () => {
  for (const title of ['นาย', 'นาง', 'นางสาว', 'เด็กชาย', 'เด็กหญิง']) {
    assert.equal(normalizeNamePrefix(title), title);
  }
});

test('maps English aliases case-insensitively, ignoring a trailing dot and surrounding whitespace', () => {
  assert.equal(normalizeNamePrefix('Mr'), 'นาย');
  assert.equal(normalizeNamePrefix('MRS'), 'นาง');
  assert.equal(normalizeNamePrefix('ms'), 'นางสาว');
  assert.equal(normalizeNamePrefix('Miss'), 'นางสาว');
  assert.equal(normalizeNamePrefix(' Mr. '), 'นาย');
});

test('rejects unknown, empty and non-string title prefixes', () => {
  for (const prefix of ['', 'Dr', 'mr..', '.', null, undefined, 42]) {
    assert.throws(() => normalizeNamePrefix(prefix), { name: 'TypeError', message: invalidPrefixMessage });
  }
});

test('formats title, first name and last name with trimmed names', () => {
  assert.equal(formatFullName('นาย', 'สมชาย', 'ใจดี'), 'นายสมชาย ใจดี');
  assert.equal(formatFullName('Ms.', '  สมหญิง ', ' รักดี '), 'นางสาวสมหญิง รักดี');
});

test('rejects blank or non-string first and last names', () => {
  for (const name of ['', '   ', null, 123]) {
    assert.throws(() => formatFullName('นาย', name, 'ใจดี'), { name: 'TypeError', message: invalidNameMessage });
    assert.throws(() => formatFullName('นาย', 'สมชาย', name), { name: 'TypeError', message: invalidNameMessage });
  }
});

test('validates the title before the names', () => {
  assert.throws(() => formatFullName('Dr', '', ''), { name: 'TypeError', message: invalidPrefixMessage });
});
