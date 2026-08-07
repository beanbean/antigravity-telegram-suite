const { parseRelativeDate, stripTaskDate } = require('./utils');

function cleanLine(text) {
  return String(text || '').replace(/^\s*\d+[.)-]?\s*/, '').trim();
}

function isPastReflectionLine(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  const lower = raw.toLocaleLowerCase('vi');
  const hasFutureCue = /(?:ngày mai|nhắc(?: anh)?|cần(?: phải)?|sẽ|phải|deadline|việc quan trọng)/iu.test(raw);
  if (hasFutureCue) return false;
  if (/^hôm nay\b/iu.test(raw)) return true;
  if (/(?:^|\s)(?:vui|mệt|ổn|bình thường|may mắn|biết ơn)(?:\s|$|[,.!])/iu.test(lower)) return true;
  if (/(?:về nhà|đi chơi|ăn (?:cơm|tối|sáng)|nghỉ ngơi|thư giãn|sum họp|về sớm)/iu.test(lower)) return true;
  return false;
}

function hasForwardTaskIntent(text) {
  const raw = String(text || '').trim();
  if (raw.length < 3 || isPastReflectionLine(raw)) return false;
  return /(?:ngày mai|nhắc(?: anh)?|cần(?: phải)?|việc(?: quan trọng)?|\bgọi\b|meeting|hẹn|deadline|sẽ\s+[\p{L}])/iu.test(raw);
}

function extractFromReflection(text, now = new Date()) {
  const raw = String(text || '').trim();
  if (!raw) return [];

  const lines = raw.split('\n').map(cleanLine).filter(Boolean);
  const changeLine = lines[1] || '';
  const tomorrowLine = lines[2] || '';
  const candidates = [];

  let taskSource = '';
  if (lines.length >= 3 && tomorrowLine) {
    taskSource = tomorrowLine;
  } else if (lines.length === 2 && hasForwardTaskIntent(lines[1])) {
    taskSource = lines[1];
  } else if (lines.length === 1 && hasForwardTaskIntent(lines[0])) {
    taskSource = lines[0];
  }

  if (taskSource && hasForwardTaskIntent(taskSource)) {
    const dueDate = parseRelativeDate(taskSource, now);
    const title = stripTaskDate(taskSource)
      .replace(/^(?:việc|task|nhắc(?: anh)?)\s*/iu, '')
      .slice(0, 180)
      .trim();
    if (title.length >= 3) {
      candidates.push({
        type: 'task',
        title,
        dueDate,
        evidence: taskSource,
        confidence: dueDate ? 'high' : 'medium',
      });
    }
  }

  if (/(?:quyết định|thay đổi|sẽ\s+(?:không|chuyển|dừng|bắt đầu)|chọn\s+)/iu.test(changeLine)) {
    const title = changeLine.slice(0, 180).trim();
    if (title.length >= 5) {
      candidates.push({
        type: 'decision',
        title,
        evidence: changeLine,
        confidence: 'medium',
      });
    }
  }

  const interactionMatch = raw.match(/\bđã\s+(?:gọi|nhắn|gặp|call|meet)\s+([\p{L}\s]{2,40})/iu);
  if (interactionMatch) {
    const personName = interactionMatch[1].trim().replace(/\s+(?:hôm nay|ngày mai).*$/iu, '');
    if (personName.length >= 2) {
      candidates.push({
        type: 'interaction',
        personName,
        evidence: interactionMatch[0],
        confidence: 'medium',
      });
    }
  }

  const seen = new Set();
  return candidates.filter((item) => {
    const key = `${item.type}:${item.title || item.personName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { extractFromReflection, cleanLine, isPastReflectionLine, hasForwardTaskIntent };
