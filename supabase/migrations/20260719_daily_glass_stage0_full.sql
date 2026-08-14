-- Daily Glass Stage 0 full PRD: habits→habit_logs, notes, events, decisions, project next action.

alter table public.tasks add column if not exists notes text;

alter table public.projects add column if not exists next_task_id uuid references public.tasks(id) on delete set null;

create table if not exists public.daily_loop_events (
  id bigserial primary key,
  chat_id text,
  event_type text not null,
  payload jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_daily_loop_events_type on public.daily_loop_events(event_type, created_at desc);

insert into public.habits (name, is_active, order_index)
select v.name, true, v.order_index
from (values
  ('Thiền', 1),
  ('Ôm hôn vợ', 2),
  ('Hỏi The ONE Thing', 3),
  ('Tập thể dục', 4),
  ('Đọc sách', 5)
) as v(name, order_index)
where not exists (
  select 1 from public.habits h where lower(h.name) = lower(v.name)
);

create or replace function public.daily_loop_log_event(
  p_chat_id text, p_event_type text, p_payload jsonb default '{}'::jsonb
) returns void language plpgsql security invoker as $$
begin
  insert into public.daily_loop_events(chat_id, event_type, payload)
  values(p_chat_id, p_event_type, coalesce(p_payload, '{}'::jsonb));
end $$;

create or replace function public.daily_loop_set_habit(
  p_chat_id text, p_date date, p_habit text, p_checked boolean
) returns boolean language plpgsql security invoker as $$
declare v_habit_id uuid;
begin
  insert into public.daily_loop_habit_state(chat_id, log_date, habit_name, checked)
  values(p_chat_id, p_date, p_habit, p_checked)
  on conflict (chat_id, log_date, habit_name) do update
    set checked = excluded.checked, updated_at = now();

  select id into v_habit_id
  from public.habits
  where lower(name) = lower(p_habit) and is_active
  order by order_index nulls last, created_at
  limit 1;

  if v_habit_id is not null then
    insert into public.habit_logs(habit_id, log_date, done)
    values(v_habit_id, p_date, p_checked)
    on conflict (habit_id, log_date) do update set done = excluded.done;
  end if;

  return p_checked;
end $$;

create or replace function public.daily_loop_habit_summary(p_date date)
returns table(habit_name text, checked boolean) language sql stable security invoker as $$
  with canonical(name, order_index) as (
    values
      ('Thiền', 1),
      ('Ôm hôn vợ', 2),
      ('Hỏi The ONE Thing', 3),
      ('Tập thể dục', 4),
      ('Đọc sách', 5)
  )
  select c.name,
    coalesce(hl.done, false) as checked
  from canonical c
  left join public.habits h on lower(h.name) = lower(c.name) and h.is_active
  left join public.habit_logs hl on hl.habit_id = h.id and hl.log_date = p_date
  order by c.order_index;
$$;

create or replace function public.daily_loop_create_task(
  p_key text, p_title text, p_due_date date, p_evidence text, p_project_id uuid default null
) returns text language plpgsql security invoker as $$
declare
  v_id text;
  v_context text;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  select entity_id into v_id from public.daily_loop_receipts where idempotency_key = p_key and action_type = 'task';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.daily_loop_receipts where idempotency_key = p_key) then
    raise exception 'idempotency key reused for different action';
  end if;

  v_context := case
    when lower(coalesce(p_title, '') || ' ' || coalesce(p_evidence, '')) ~ '(gọi|goi|call|nhắn|nhan|meet|hẹn|hen|chăm|cham)' then 'connection'
    when lower(coalesce(p_title, '') || ' ' || coalesce(p_evidence, '')) ~ '(công|cong|work|dự án|du an|project|team)' then 'work'
    else 'personal'
  end;

  insert into public.tasks(title, due_date, context, notes, project_id)
  values(p_title, p_due_date, v_context, p_evidence, p_project_id)
  returning id::text into v_id;

  if p_project_id is not null then
    update public.projects set next_task_id = v_id::uuid where id = p_project_id;
  end if;

  insert into public.daily_loop_receipts(idempotency_key, action_type, entity_id, created_at)
  values(p_key, 'task', v_id, now());

  return v_id;
end $$;

create or replace function public.daily_loop_create_decision(
  p_key text, p_title text, p_context text, p_decided_at date
) returns text language plpgsql security invoker as $$
declare v_id text;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  select entity_id into v_id from public.daily_loop_receipts where idempotency_key = p_key and action_type = 'decision';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.daily_loop_receipts where idempotency_key = p_key) then
    raise exception 'idempotency key reused for different action';
  end if;

  insert into public.decisions(decided_at, title, context)
  values(p_decided_at, p_title, p_context)
  returning id::text into v_id;

  insert into public.daily_loop_receipts(idempotency_key, action_type, entity_id, created_at)
  values(p_key, 'decision', v_id, now());

  return v_id;
end $$;

create or replace function public.daily_loop_projects_need_review()
returns table(project_id uuid, project_name text, project_status text) language sql stable security invoker as $$
  select p.id, p.name, p.status
  from public.projects p
  where p.status in ('active', 'next')
    and not exists (
      select 1 from public.tasks t
      where t.project_id = p.id
        and coalesce(t.status, 'todo') not in ('done', 'cancelled', 'completed')
    )
  order by p.name;
$$;

create or replace function public.daily_loop_set_project_status(
  p_project_id uuid, p_status text
) returns boolean language plpgsql security invoker as $$
begin
  if p_status not in ('active', 'next', 'future', 'someday', 'completed', 'cancelled') then
    raise exception 'invalid project status';
  end if;
  update public.projects set status = p_status where id = p_project_id;
  return found;
end $$;

create or replace function public.daily_loop_link_project_next_task(
  p_project_id uuid, p_task_id uuid
) returns boolean language plpgsql security invoker as $$
begin
  update public.projects set next_task_id = p_task_id where id = p_project_id;
  return found;
end $$;
