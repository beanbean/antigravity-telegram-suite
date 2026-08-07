const dateKey = (date = new Date()) => date.toLocaleDateString('en-CA', { timeZone: process.env.TZ || 'Asia/Ho_Chi_Minh' });

function parseRelativeDate(text, now = new Date()) {
  const lower = String(text || '').toLocaleLowerCase('vi');
  const offset = /\bngày mai\b/.test(lower) ? 1 : /\bhôm nay\b/.test(lower) ? 0 : null;
  if (offset === null) return null;
  const today = dateKey(now);
  if (!offset) return today;
  const [year, month, day] = today.split('-').map(Number);
  return dateKey(new Date(Date.UTC(year, month - 1, day + offset, 12)));
}

function stripTaskDate(text) {
  return String(text || '').replace(/\s+(?:vào\s+)?(?:ngày mai|hôm nay)\s*$/iu, '').trim();
}

function startOfWeek(day) {
  const date = new Date(`${day}T12:00:00`);
  const weekday = date.getDay() || 7;
  date.setDate(date.getDate() - weekday + 1);
  return dateKey(date);
}

module.exports = { dateKey, parseRelativeDate, stripTaskDate, startOfWeek };
