const { dateKey, startOfWeek } = require('./utils');

async function buildFocusProposal(db, day) {
  const weekStart = startOfWeek(day);

  const weekly = await db.safeQuery(
    'SELECT goal FROM weekly_focus WHERE week_start = ? LIMIT 1;',
    [weekStart]
  );
  if (weekly.ok && weekly.rows[0]?.goal) {
    return {
      title: weekly.rows[0].goal,
      reason: `Mục tiêu tuần (${weekStart}): ưu tiên theo Weekly Reset đã chốt.`,
      source: 'weekly_focus',
      trustworthy: true,
      linkedTaskId: null,
      linkedProjectId: null,
    };
  }

  const projectNext = await db.safeQuery(
    `SELECT p.id AS project_id, p.name, t.id AS task_id, t.title, t.due_date
     FROM projects p
     JOIN tasks t ON t.id = p.next_task_id
     WHERE p.status IN ('active', 'next')
       AND coalesce(t.status, 'todo') NOT IN ('done', 'cancelled', 'completed')
     ORDER BY t.due_date NULLS LAST, p.name
     LIMIT 1;`,
    []
  );
  if (projectNext.ok && projectNext.rows[0]) {
    const row = projectNext.rows[0];
    return {
      title: row.title,
      reason: `Next action của project “${row.name}”${row.due_date ? ` (due ${row.due_date})` : ''}.`,
      source: 'project_next',
      trustworthy: true,
      linkedTaskId: row.task_id,
      linkedProjectId: row.project_id,
    };
  }

  const openProjectTask = await db.safeQuery(
    `SELECT t.id, t.title, t.due_date, p.id AS project_id, p.name AS project_name
     FROM tasks t
     JOIN projects p ON p.id = t.project_id
     WHERE p.status IN ('active', 'next')
       AND coalesce(t.status, 'todo') NOT IN ('done', 'cancelled', 'completed')
       AND t.due_date IS NOT NULL AND t.due_date <= ?
     ORDER BY CASE WHEN t.due_date < ? THEN 0 ELSE 1 END, t.due_date ASC, t.created_at ASC
     LIMIT 1;`,
    [day, day]
  );
  if (openProjectTask.ok && openProjectTask.rows[0]) {
    const row = openProjectTask.rows[0];
    return {
      title: row.title,
      reason: `Task project “${row.project_name}” đến hạn ${row.due_date}.`,
      source: 'project_task',
      trustworthy: true,
      linkedTaskId: row.id,
      linkedProjectId: row.project_id,
    };
  }

  const dueTask = await db.safeQuery(
    `SELECT t.id, t.title, t.due_date
     FROM tasks t
     WHERE coalesce(t.status, 'todo') NOT IN ('done', 'cancelled', 'completed')
       AND t.due_date IS NOT NULL AND t.due_date <= ?
     ORDER BY CASE WHEN t.due_date < ? THEN 0 ELSE 1 END, t.due_date ASC, t.created_at ASC
     LIMIT 1;`,
    [day, day]
  );
  if (dueTask.ok && dueTask.rows[0]) {
    const row = dueTask.rows[0];
    return {
      title: row.title,
      reason: `Task đến hạn ${row.due_date}; ưu tiên overdue trước, rồi đến hạn hôm nay.`,
      source: 'due_task',
      trustworthy: true,
      linkedTaskId: row.id,
      linkedProjectId: null,
    };
  }

  const followup = await db.safeQuery(
    `SELECT id, name, next_followup
     FROM people
     WHERE next_followup IS NOT NULL AND next_followup <= ?::date + interval '3 days'
     ORDER BY priority ASC NULLS LAST, next_followup ASC
     LIMIT 1;`,
    [day]
  );
  if (followup.ok && followup.rows[0]) {
    const row = followup.rows[0];
    return {
      title: `Chăm ${row.name}`,
      reason: `People follow-up${row.next_followup ? ` (hạn ${String(row.next_followup).slice(0, 10)})` : ''}.`,
      source: 'people_followup',
      trustworthy: true,
      linkedTaskId: null,
      linkedProjectId: null,
      linkedPersonId: row.id,
    };
  }

  return null;
}

module.exports = { buildFocusProposal };
