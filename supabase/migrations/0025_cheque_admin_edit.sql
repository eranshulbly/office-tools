-- ============================================================================
-- 0025_cheque_admin_edit.sql — let an ADMIN fix any editable field on a cheque
-- (from the reconciliation edit modal), for any non-settled cheque. Reuses
-- apply_cheque_fields; admin-only. Idempotent.
-- ============================================================================

create or replace function public.admin_update_cheque(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admin_update_cheque: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status in ('passed', 'bounced') then
    raise exception 'a settled cheque (% ) cannot be edited', c.status;
  end if;
  perform public.apply_cheque_fields(p_id, p);
  perform public.write_audit('cheque_admin_edited', 'cheques', p_id::text, null, p, null);
end;
$$;
grant execute on function public.admin_update_cheque(uuid, jsonb) to authenticated;
