const INVALID_PREFIX_MESSAGE = 'คำนำหน้าชื่อไม่ถูกต้อง: ใช้ นาย, นาง, นางสาว, เด็กชาย, เด็กหญิง, Mr, Mrs, Ms หรือ Miss';
const INVALID_NAME_MESSAGE = 'ชื่อหรือนามสกุลไม่ถูกต้อง: ต้องเป็นข้อความที่ไม่ว่าง';
const PREFIXES = new Map([
  ['นาย', 'นาย'],
  ['นาง', 'นาง'],
  ['นางสาว', 'นางสาว'],
  ['เด็กชาย', 'เด็กชาย'],
  ['เด็กหญิง', 'เด็กหญิง'],
  ['mr', 'นาย'],
  ['mrs', 'นาง'],
  ['ms', 'นางสาว'],
  ['miss', 'นางสาว'],
]);

export function normalizeNamePrefix(prefix) {
  if (typeof prefix !== 'string') {
    throw new TypeError(INVALID_PREFIX_MESSAGE);
  }

  let key = prefix.trim();
  if (key.endsWith('.')) {
    key = key.slice(0, -1);
  }
  key = key.trim().toLowerCase();

  const canonical = PREFIXES.get(key);
  if (!canonical) {
    throw new TypeError(INVALID_PREFIX_MESSAGE);
  }
  return canonical;
}

function cleanName(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(INVALID_NAME_MESSAGE);
  }
  return value.trim();
}

export function formatFullName(prefix, firstName, lastName) {
  const title = normalizeNamePrefix(prefix);
  const first = cleanName(firstName);
  const last = cleanName(lastName);
  return `${title}${first} ${last}`;
}
