import { pathToFileURL } from 'node:url';

const INVALID_DATE_MESSAGE = 'วันเกิดไม่ถูกต้อง: กรุณาใช้วันที่จริงในรูปแบบ YYYY-MM-DD';
const FUTURE_DATE_MESSAGE = 'วันเกิดต้องไม่อยู่ในอนาคต';
const USAGE_MESSAGE = 'วิธีใช้: node examples/age-calculator.mjs YYYY-MM-DD';

function parseDate(value) {
  if (typeof value !== 'string') {
    throw new TypeError(INVALID_DATE_MESSAGE);
  }

  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new TypeError(INVALID_DATE_MESSAGE);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) {
    throw new TypeError(INVALID_DATE_MESSAGE);
  }

  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (day < 1 || day > daysInMonth[month - 1]) {
    throw new TypeError(INVALID_DATE_MESSAGE);
  }

  return { year, month, day };
}

function compareDates(left, right) {
  return left.year - right.year || left.month - right.month || left.day - right.day;
}

export function calculateAge(birthDate, referenceDate) {
  const birth = parseDate(birthDate);
  const reference = parseDate(referenceDate);
  if (compareDates(birth, reference) > 0) {
    throw new RangeError(FUTURE_DATE_MESSAGE);
  }

  let anniversaryMonth = birth.month;
  let anniversaryDay = birth.day;
  if (birth.month === 2 && birth.day === 29 && !(reference.year % 4 === 0 && (reference.year % 100 !== 0 || reference.year % 400 === 0))) {
    anniversaryMonth = 3;
    anniversaryDay = 1;
  }

  const anniversaryPassed = reference.month > anniversaryMonth ||
    (reference.month === anniversaryMonth && reference.day >= anniversaryDay);
  return reference.year - birth.year - (anniversaryPassed ? 0 : 1);
}

function localToday() {
  const today = new Date();
  const year = String(today.getFullYear()).padStart(4, '0');
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function runCli(args) {
  if (args.length !== 1) {
    console.error(USAGE_MESSAGE);
    process.exitCode = 2;
    return;
  }

  try {
    console.log(`อายุ: ${calculateAge(args[0], localToday())} ปี`);
  } catch (error) {
    console.error(error instanceof RangeError ? FUTURE_DATE_MESSAGE : INVALID_DATE_MESSAGE);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2));
}
