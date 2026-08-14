-- Apply manually from HOTBRAIN_WORKDIR after reviewing the live schema.
create table if not exists public.daily_focus (
  id uuid primary key default gen_random_uuid(),
  focus_date date not null unique,
  title text not null,
  reason text,
  source_type text not null check (source_type in ('ai_proposed', 'user_entered')),
  status text not null check (status in ('proposed', 'confirmed', 'replaced', 'completed')),
  linked_task_id uuid,
  linked_project_id uuid,
  replacement_reason text,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.weekly_focus (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  goal text not null,
  lesson text,
  adjustment text,
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_loop_receipts (
  idempotency_key text primary key,
  action_type text not null,
  entity_id text,
  created_at timestamptz not null default now()
);

create table if not exists public.daily_loop_habit_state (
  chat_id text not null,
  log_date date not null,
  habit_name text not null,
  checked boolean not null,
  updated_at timestamptz not null default now(),
  primary key (chat_id, log_date, habit_name)
);

create or replace function public.daily_loop_upsert_focus(
  p_date date, p_title text, p_reason text, p_source text, p_status text, p_linked_task_id uuid default null
) returns uuid language plpgsql security invoker as $$
declare v_id uuid;
begin
  insert into public.daily_focus(focus_date,title,reason,source_type,status,linked_task_id,confirmed_at)
  values(p_date,p_title,p_reason,p_source,p_status,p_linked_task_id,case when p_status='confirmed' then now() end)
  on conflict(focus_date) do update set
    title=excluded.title, reason=excluded.reason, source_type=excluded.source_type,
    status=excluded.status,
    linked_task_id=coalesce(excluded.linked_task_id, public.daily_focus.linked_task_id),
    confirmed_at=excluded.confirmed_at, updated_at=now()
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.daily_loop_set_habit(
  p_chat_id text, p_date date, p_habit text, p_checked boolean
) returns boolean language plpgsql security invoker as $$
begin
  insert into public.daily_loop_habit_state(chat_id,log_date,habit_name,checked)
  values(p_chat_id,p_date,p_habit,p_checked)
  on conflict(chat_id,log_date,habit_name) do update set checked=excluded.checked,updated_at=now();
  return p_checked;
end $$;

-- These functions deliberately isolate Stage 0 from schema drift in existing tables.
-- Adapt only their INSERT columns after checking the live tasks/interactions contracts.
create or replace function public.daily_loop_create_task(
  p_key text, p_title text, p_due_date date, p_evidence text
) returns text language plpgsql security invoker as $$
declare v_id text;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  select entity_id into v_id from public.daily_loop_receipts where idempotency_key=p_key and action_type='task';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.daily_loop_receipts where idempotency_key=p_key) then
    raise exception 'idempotency key reused for different action';
  end if;
  insert into public.tasks(title, due_date, context)
  values(
    p_title,
    p_due_date,
    case
      when lower(coalesce(p_title, '') || ' ' || coalesce(p_evidence, '')) ~ '(gọi|goi|call|nhắn|nhan|meet|hẹn|hen|chăm|cham)' then 'connection'
      when lower(coalesce(p_title, '') || ' ' || coalesce(p_evidence, '')) ~ '(công|cong|work|dự án|du an|project|team)' then 'work'
      else 'personal'
    end
  ) returning id::text into v_id;
  insert into public.daily_loop_receipts values(p_key,'task',v_id,now());
  return v_id;
end $$;

create or replace function public.daily_loop_create_interaction(
  p_key text, p_person_id uuid, p_date date, p_evidence text
) returns text language plpgsql security invoker as $$
declare v_id text;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  select entity_id into v_id from public.daily_loop_receipts where idempotency_key=p_key and action_type='interaction';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.daily_loop_receipts where idempotency_key=p_key) then
    raise exception 'idempotency key reused for different action';
  end if;
  insert into public.interactions(person_id, interaction_date, interaction_type, context)
  values(p_person_id,p_date,'message',p_evidence) returning id::text into v_id;
  insert into public.daily_loop_receipts values(p_key,'interaction',v_id,now());
  return v_id;
end $$;

create or replace function public.daily_loop_upsert_weekly(
  p_key text, p_week_start date, p_goal text, p_lesson text, p_adjustment text
) returns text language plpgsql security invoker as $$
declare v_id text;
begin
  perform pg_advisory_xact_lock(hashtext(p_key));
  select entity_id into v_id from public.daily_loop_receipts where idempotency_key=p_key and action_type='weekly';
  if v_id is not null then return v_id; end if;
  if exists(select 1 from public.daily_loop_receipts where idempotency_key=p_key) then
    raise exception 'idempotency key reused for different action';
  end if;
  insert into public.weekly_focus(week_start,goal,lesson,adjustment,reviewed_at)
  values(p_week_start,p_goal,p_lesson,p_adjustment,now())
  on conflict(week_start) do update set goal=excluded.goal,lesson=excluded.lesson,
    adjustment=excluded.adjustment,reviewed_at=now()
  returning id::text into v_id;
  insert into public.daily_loop_receipts values(p_key,'weekly',v_id,now());
  return v_id;
end $$;
