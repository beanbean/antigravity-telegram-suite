-- Fix: tasks.context is enum (work|personal|connection), not free-text evidence.
create or replace function public.daily_loop_create_task(
  p_key text, p_title text, p_due_date date, p_evidence text
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

  insert into public.tasks(title, due_date, context)
  values(p_title, p_due_date, v_context)
  returning id::text into v_id;

  insert into public.daily_loop_receipts(idempotency_key, action_type, entity_id, created_at)
  values(p_key, 'task', v_id, now());

  return v_id;
end $$;
