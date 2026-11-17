-- ============================================================================
-- 0017_employee_code_auto.sql — employee code is now AUTO-ASSIGNED (managers/
-- admins no longer type it), device user ID becomes OPTIONAL (assigned later
-- when the person is enrolled on the punch device), and phone + group become
-- REQUIRED at creation. Enforcement:
--   • employee_code: sequence-backed generator + column default.
--   • device_user_id: column made nullable (unique still holds; NULLs allowed).
--   • phone / group required: enforced in request_new_worker RPC + app validation.
-- Idempotent.
-- ============================================================================

-- ── auto employee code ───────────────────────────────────────────────────────
create sequence if not exists employee_code_seq;

-- 'EMP-0001', 'EMP-0002', … — loops past any manual collision. Security definer
-- so it can read workers / advance the sequence regardless of caller RLS.
create or replace function public.next_employee_code()
returns text language plpgsql security definer set search_path = public as $$
declare code text; n bigint;
begin
  loop
    n := nextval('employee_code_seq');
    code := 'EMP-' || lpad(n::text, 4, '0');
    exit when not exists (select 1 from workers where employee_code = code);
  end loop;
  return code;
end;
$$;
grant execute on function public.next_employee_code() to authenticated;

-- New rows without an explicit code get one automatically (admin direct insert).
alter table workers alter column employee_code set default public.next_employee_code();

-- ── device user ID optional ──────────────────────────────────────────────────
alter table workers alter column device_user_id drop not null;

-- ── manager NEW-worker RPC: auto code, optional device, required phone+group ──
create or replace function public.request_new_worker(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_id uuid; v_device int; v_code text;
begin
  if not public.is_manager() then
    raise exception 'request_new_worker: managers only' using errcode = 'insufficient_privilege';
  end if;

  v_group := nullif(p->>'group_id', '')::uuid;
  if v_group is null or not public.can_disburse_group(v_group) then
    raise exception 'you can only add workers to your own groups';
  end if;
  if coalesce(trim(p->>'full_name'), '') = '' then
    raise exception 'full name is required';
  end if;
  if coalesce(trim(p->>'phone'), '') = '' then
    raise exception 'phone number is required';
  end if;

  -- device user ID (PIN) is OPTIONAL now — set later when enrolled on the device.
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
