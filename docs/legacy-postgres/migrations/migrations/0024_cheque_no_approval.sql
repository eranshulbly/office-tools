-- ============================================================================
-- 0024_cheque_no_approval.sql — remove the cheque APPROVAL step. A submitted
-- cheque now goes straight to 'submitted' (ready for reconciliation / bank
-- presentation) instead of 'pending'. The 'pending'/'rejected' enum values are
-- kept for history but are no longer produced. Idempotent.
-- ============================================================================

create or replace function public.submit_cheque(p_id uuid)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if auth.uid() is not null and not public.is_admin() and c.uploaded_by <> auth.uid() then
    raise exception 'you can only submit cheques you uploaded' using errcode = 'insufficient_privilege';
  end if;
  if c.status not in ('draft', 'rejected') then
    raise exception 'cheque % is not editable (status %)', p_id, c.status;
  end if;
  if coalesce(trim(c.cheque_number), '') = '' or c.amount is null or c.amount <= 0
     or coalesce(trim(c.dealer_name), '') = '' then
    raise exception 'cheque number, a positive amount, and dealer name are required before submitting';
  end if;
  -- straight to submitted (no approval): ready for reconciliation.
  update cheques
    set status = 'submitted', submitted_at = now(),
        decided_by = null, decided_at = null, decision_reason = null
    where id = p_id;
  perform public.write_audit('cheque_submitted', 'cheques', p_id::text, null, null, null);
end;
$$;
