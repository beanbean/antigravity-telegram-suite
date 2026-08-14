-- Patch: persist linked_task_id when confirming Daily Glass focus.
create or replace function public.daily_loop_upsert_focus(
  p_date date,
  p_title text,
  p_reason text,
  p_source text,
  p_status text,
  p_linked_task_id uuid default null
) returns uuid language plpgsql security invoker as $$
declare v_id uuid;
begin
  insert into public.daily_focus(
    focus_date, title, reason, source_type, status, linked_task_id, confirmed_at
  )
  values(
    p_date, p_title, p_reason, p_source, p_status, p_linked_task_id,
    case when p_status = 'confirmed' then now() end
  )
  on conflict (focus_date) do update set
    title = excluded.title,
    reason = excluded.reason,
    source_type = excluded.source_type,
    status = excluded.status,
    linked_task_id = coalesce(excluded.linked_task_id, public.daily_focus.linked_task_id),
    confirmed_at = excluded.confirmed_at,
    updated_at = now()
  returning id into v_id;
  return v_id;
end $$;
