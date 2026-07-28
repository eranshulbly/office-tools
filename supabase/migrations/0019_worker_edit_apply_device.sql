-- ============================================================================
-- 0019_worker_edit_apply_device.sql — manager edit requests now carry ONLY the
-- fields that actually changed (see requestWorkerEdit). The admin-apply step
-- (decide_worker_edit) already uses present-key semantics for phone/group/
-- left_on/is_active, but device_user_id used coalesce((p->>'device_user_id')::int,…)
-- which (a) can't tell "absent" from "cleared" and (b) errors on the empty string.
-- Switch it to present-key + empty→NULL so a PIN can be changed OR cleared, and
-- an absent key leaves it untouched. Only that one line changes. Idempotent.
-- ============================================================================

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
      device_user_id= case when p ? 'device_user_id' then nullif(p->>'device_user_id','')::int else device_user_id end,
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
