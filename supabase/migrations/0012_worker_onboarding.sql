-- ============================================================================
-- 0012_worker_onboarding.sql — managers add/edit workers, admin approves.
--   • Managers submit NEW workers (everything except salary & bank) into their
--     own groups. Created pending + inactive → not in attendance/payroll until
--     an admin sets salary + bank and approves.
--   • Managers submit EDITS to their group's workers → held as pending changes;
--     the live worker is untouched until an admin approves them.
--   • All privileged work runs through security-definer RPCs; the admin adds the
--     confidential fields.
-- ============================================================================

-- ── workers: allow a pending, salary-less row ────────────────────────────────
alter table workers alter column monthly_salary drop not null;  -- null until approved
alter table workers add column if not exists approval_status text not null default 'active';
do $$ begin
  alter table workers add constraint workers_approval_status_chk
    check (approval_status in ('active', 'pending', 'rejected'));
exception when duplicate_object then null; end $$;
alter table workers add column if not exists created_by uuid references profiles(id);
alter table workers add column if not exists approved_by uuid references profiles(id);

-- ── pending edit requests ────────────────────────────────────────────────────
create table if not exists worker_edit_requests (
  id uuid primary key default gen_random_uuid(),
  worker_id uuid not null references workers(id) on delete cascade,
  payload jsonb not null,              -- proposed NON-confidential fields only
  status request_status not null default 'pending',
  requested_by uuid not null references profiles(id),
  requested_at timestamptz not null default now(),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  decision_reason text
);
create index if not exists wer_status_idx on worker_edit_requests (status);
alter table worker_edit_requests enable row level security;
drop policy if exists wer_select on worker_edit_requests;
create policy wer_select on worker_edit_requests for select using (auth.uid() is not null);
drop policy if exists wer_admin_all on worker_edit_requests;
create policy wer_admin_all on worker_edit_requests for all using (public.is_admin()) with check (public.is_admin());
-- Manager inserts happen through the request_worker_edit RPC (security definer).

-- ── Storage: let staff upload worker photo + id proof (managers onboard) ──────
-- Photos remain staff-readable; id proofs remain admin-read-only. Uploads are
-- now allowed for any authenticated staff so a manager can attach them.
drop policy if exists worker_photos_staff_insert on storage.objects;
create policy worker_photos_staff_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'worker-photos');

drop policy if exists worker_id_proofs_staff_insert on storage.objects;
create policy worker_id_proofs_staff_insert on storage.objects
  for insert to authenticated with check (bucket_id = 'worker-id-proofs');

-- ── Manager: submit a NEW worker (pending) ───────────────────────────────────
create or replace function public.request_new_worker(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_id uuid;
begin
  if not public.is_manager() then
    raise exception 'request_new_worker: managers only' using errcode = 'insufficient_privilege';
  end if;
  v_group := nullif(p->>'group_id', '')::uuid;
  if v_group is null or not public.can_disburse_group(v_group) then
    raise exception 'you can only add workers to your own groups';
  end if;
  if coalesce(trim(p->>'employee_code'), '') = '' or coalesce(trim(p->>'full_name'), '') = '' then
    raise exception 'employee code and full name are required';
  end if;
  if (p->>'device_user_id') is null or (p->>'device_user_id') !~ '^\d+$' then
    raise exception 'device user ID (PIN) must be a whole number';
  end if;

  insert into workers
    (employee_code, full_name, device_user_id, monthly_salary, joined_on,
     phone, group_id, is_active, approval_status, created_by)
  values
    (trim(p->>'employee_code'), trim(p->>'full_name'), (p->>'device_user_id')::int,
     null, coalesce((p->>'joined_on')::date, current_date),
     nullif(p->>'phone',''), v_group, false, 'pending', auth.uid())
  returning id into v_id;

  perform public.write_audit('worker_new_requested', 'workers', v_id::text, null, p, null);
  return v_id;
end;
$$;
grant execute on function public.request_new_worker(jsonb) to authenticated;

-- ── Manager: submit an EDIT to a worker in their group ───────────────────────
create or replace function public.request_worker_edit(p_worker uuid, p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_group uuid; v_id uuid;
begin
  if not public.is_manager() then
    raise exception 'request_worker_edit: managers only' using errcode = 'insufficient_privilege';
  end if;
  select group_id into v_group from workers where id = p_worker;
  if not public.can_disburse_group(v_group) then
    raise exception 'you can only edit workers in your own groups';
  end if;

  insert into worker_edit_requests (worker_id, payload, requested_by)
  values (p_worker, p, auth.uid())
  returning id into v_id;

  perform public.write_audit('worker_edit_requested', 'workers', p_worker::text, null, p, null);
  return v_id;
end;
$$;
grant execute on function public.request_worker_edit(uuid, jsonb) to authenticated;

-- ── Admin: approve a new worker (adds the confidential fields) ───────────────
create or replace function public.approve_new_worker(
  p_worker uuid, p_salary numeric, p_bank_account text, p_bank_ifsc text
) returns void language plpgsql security definer set search_path = public as $$
declare w workers%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'approve_new_worker: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into w from workers where id = p_worker for update;
  if w.id is null then raise exception 'worker % not found', p_worker; end if;
  if w.approval_status <> 'pending' then raise exception 'worker % is not pending', p_worker; end if;
  if p_salary is null or p_salary <= 0 then raise exception 'a monthly salary greater than 0 is required'; end if;

  update workers
  set monthly_salary = p_salary, is_active = true, approval_status = 'active', approved_by = auth.uid()
  where id = p_worker;

  if coalesce(trim(p_bank_account), '') <> '' or coalesce(trim(p_bank_ifsc), '') <> '' then
    insert into worker_bank_details (worker_id, bank_account, bank_ifsc)
    values (p_worker, nullif(trim(p_bank_account),''), nullif(trim(p_bank_ifsc),''))
    on conflict (worker_id) do update set bank_account = excluded.bank_account, bank_ifsc = excluded.bank_ifsc, updated_at = now();
  end if;

  perform public.write_audit('worker_new_approved', 'workers', p_worker::text, null,
    jsonb_build_object('salary', p_salary), null);
end;
$$;
grant execute on function public.approve_new_worker(uuid, numeric, text, text) to authenticated;

create or replace function public.reject_new_worker(p_worker uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'reject_new_worker: admin only' using errcode = 'insufficient_privilege';
  end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'rejection requires a reason'; end if;
  update workers set approval_status = 'rejected', is_active = false
   where id = p_worker and approval_status = 'pending';
  perform public.write_audit('worker_new_rejected', 'workers', p_worker::text, null, null, p_reason);
end;
$$;
grant execute on function public.reject_new_worker(uuid, text) to authenticated;

-- ── Admin: decide an edit request (apply non-confidential fields on approve) ──
create or replace function public.decide_worker_edit(p_id uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare req worker_edit_requests%rowtype; p jsonb;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'decide_worker_edit: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into req from worker_edit_requests where id = p_id for update;
  if req.id is null then raise exception 'edit request % not found', p_id; end if;
  if req.status <> 'pending' then raise exception 'edit request % already decided', p_id; end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then raise exception 'rejection requires a reason'; end if;

  if p_approve then
    p := req.payload;
    update workers set
      full_name     = coalesce(nullif(p->>'full_name',''), full_name),
      employee_code = coalesce(nullif(p->>'employee_code',''), employee_code),
      device_user_id= coalesce((p->>'device_user_id')::int, device_user_id),
      phone         = case when p ? 'phone'   then nullif(p->>'phone','')          else phone end,
      group_id      = case when p ? 'group_id' then nullif(p->>'group_id','')::uuid else group_id end,
      joined_on     = coalesce((p->>'joined_on')::date, joined_on),
      left_on       = case when p ? 'left_on' then nullif(p->>'left_on','')::date  else left_on end,
      is_active     = case when p ? 'is_active' then (p->>'is_active')::boolean     else is_active end
    where id = req.worker_id;
  end if;

  update worker_edit_requests
  set status = case when p_approve then 'approved' else 'rejected' end::request_status,
      decided_by = auth.uid(), decided_at = now(), decision_reason = p_reason
  where id = p_id;

  perform public.write_audit(
    case when p_approve then 'worker_edit_approved' else 'worker_edit_rejected' end,
    'workers', req.worker_id::text, null, req.payload, p_reason);
end;
$$;
grant execute on function public.decide_worker_edit(uuid, boolean, text) to authenticated;
