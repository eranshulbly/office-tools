-- ============================================================================
-- 0028_cheque_auto_settle.sql — admin auto-reconciliation from a bank ledger.
-- Settles an OUTSTANDING cheque (submitted/presented) straight to passed or
-- bounced in one step, recording the presentation + outcome dates read from the
-- statement. Admin only; refuses draft/settled cheques. Idempotent.
-- ============================================================================

create or replace function public.admin_auto_settle_cheque(
  p_id uuid,
  p_passed boolean,
  p_presented_date date,
  p_outcome_date date,
  p_reason text
) returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admin_auto_settle_cheque: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status not in ('submitted', 'presented') then
    raise exception 'only an outstanding cheque can be auto-settled (cheque % is %)', p_id, c.status;
  end if;

  update cheques set
    status         = case when p_passed then 'passed' else 'bounced' end::cheque_status,
    presented_date = coalesce(presented_date, p_presented_date, current_date),
    cleared_date   = coalesce(p_outcome_date, current_date),
    bounce_reason  = case when p_passed then null else nullif(trim(p_reason), '') end
  where id = p_id;

  perform public.write_audit(
    case when p_passed then 'cheque_auto_passed' else 'cheque_auto_bounced' end,
    'cheques', p_id::text, null,
    jsonb_build_object('presented_date', p_presented_date, 'outcome_date', p_outcome_date, 'reason', p_reason),
    null);
end;
$$;
grant execute on function public.admin_auto_settle_cheque(uuid, boolean, date, date, text) to authenticated;
