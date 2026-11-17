-- ============================================================================
-- 0016_cheque_received_date.sql — add "received date" (when the dealer physically
-- handed over the cheque), separate from the system upload_date (§B4). Manager-
-- editable, so it joins apply_cheque_fields. Idempotent.
-- ============================================================================

alter table cheques add column if not exists received_date date;

-- Re-create the editable-field applier to also carry received_date.
create or replace function public.apply_cheque_fields(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update cheques set
    cheque_number   = case when p ? 'cheque_number'   then nullif(p->>'cheque_number','')          else cheque_number end,
    cheque_date     = case when p ? 'cheque_date'     then nullif(p->>'cheque_date','')::date       else cheque_date end,
    received_date   = case when p ? 'received_date'   then nullif(p->>'received_date','')::date     else received_date end,
    amount          = case when p ? 'amount'          then nullif(p->>'amount','')::numeric         else amount end,
    amount_in_words = case when p ? 'amount_in_words' then nullif(p->>'amount_in_words','')         else amount_in_words end,
    dealer_name     = case when p ? 'dealer_name'     then nullif(p->>'dealer_name','')             else dealer_name end,
    bank_name       = case when p ? 'bank_name'       then nullif(p->>'bank_name','')               else bank_name end,
    branch          = case when p ? 'branch'          then nullif(p->>'branch','')                  else branch end,
    ifsc            = case when p ? 'ifsc'            then nullif(p->>'ifsc','')                    else ifsc end,
    account_number  = case when p ? 'account_number'  then nullif(p->>'account_number','')          else account_number end,
    micr_code       = case when p ? 'micr_code'       then nullif(p->>'micr_code','')               else micr_code end,
    payee_name      = case when p ? 'payee_name'      then nullif(p->>'payee_name','')              else payee_name end,
    notes           = case when p ? 'notes'           then nullif(p->>'notes','')                   else notes end
  where id = p_id;
end;
$$;
