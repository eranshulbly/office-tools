-- ============================================================================
-- 0018_manager_propose_any_group.sql — a manager adding a NEW employee may
-- propose ANY group, not only their own. Everything a manager submits is PENDING
-- admin approval, so the group choice is just a proposal; group segregation is
-- enforced where it matters (payroll disbursement + confidential-data access),
-- not at employee entry. Only the group check in request_new_worker changes;
-- the rest of the function is unchanged from 0017. Idempotent.
-- ============================================================================

create or replace function public.request_new_worker(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_id uuid; v_device int; v_code text;
begin
  if not public.is_manager() then
    raise exception 'request_new_worker: managers only' using errcode = 'insufficient_privilege';
  end if;

  -- A manager may PROPOSE any existing group (pending admin approval) — no
  -- can_disburse_group() restriction here.
  v_group := nullif(p->>'group_id', '')::uuid;
  if v_group is null then
    raise exception 'please choose a group';
  end if;
  if not exists (select 1 from worker_groups where id = v_group) then
    raise exception 'the selected group does not exist';
  end if;

  if coalesce(trim(p->>'full_name'), '') = '' then
    raise exception 'full name is required';
  end if;
  if coalesce(trim(p->>'phone'), '') = '' then
    raise exception 'phone number is required';
  end if;

  -- device user ID (PIN) is OPTIONAL — set later when enrolled on the device.
  if coalesce(p->>'device_user_id', '') <> '' then
    if (p->>'device_user_id') !~ '^\d+$' then
      raise exception 'device user ID (PIN) must be a whole number';
    end if;
    v_device := (p->>'device_user_id')::int;
  else
    v_device := null;
  end if;

  v_code := public.next_employee_code();

  insert into workers
    (employee_code, full_name, device_user_id, monthly_salary, joined_on,
     phone, group_id, is_active, approval_status, created_by)
  values
    (v_code, trim(p->>'full_name'), v_device,
     null, coalesce((p->>'joined_on')::date, current_date),
     nullif(p->>'phone',''), v_group, false, 'pending', auth.uid())
  returning id into v_id;

  perform public.write_audit('worker_new_requested', 'workers', v_id::text, null, p, null);
  return v_id;
end;
$$;
grant execute on function public.request_new_worker(jsonb) to authenticated;
