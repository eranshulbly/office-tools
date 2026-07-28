-- ============================================================================
-- 0015_cheque_reconciliation.sql — Cheque Reconciliation (Phase 1).
--   Managers upload/enter dealer cheques (manual entry in Phase 1; AI/OCR
--   auto-fill lands in a later phase). Lifecycle:
--       draft → pending → (rejected → draft) → submitted → presented
--                                                   → passed | bounced
--   • Images are EXTRACT-AND-FORGET: never stored. No bucket, no image column.
--   • Dealer name is FREE TEXT (no dealer master).
--   • ALL managers can SEE all cheques; a manager may EDIT/SUBMIT only the ones
--     they uploaded. Every privileged write is a security-definer RPC so admin-
--     only fields (approval, bank presentation, outcome) can't be tampered with.
--   • Reconciliation v1 = track each cheque to passed/bounced (no statement match).
-- Idempotent: re-applied in full on every db:push.
-- ============================================================================

-- ── status enum ──────────────────────────────────────────────────────────────
do $$ begin
  create type cheque_status as enum
    ('draft', 'pending', 'rejected', 'submitted', 'presented', 'passed', 'bounced');
exception when duplicate_object then null; end $$;

-- ── our own bank accounts (admin master; "presented to which of OUR banks") ───
create table if not exists company_bank_accounts (
  id             uuid primary key default gen_random_uuid(),
  label          text not null,               -- e.g. "HDFC Current – 1234"
  bank_name      text,
  account_number text,
  ifsc           text,
  is_active      boolean not null default true,
  created_at     timestamptz not null default now()
);
alter table company_bank_accounts enable row level security;
drop policy if exists cba_select on company_bank_accounts;
create policy cba_select on company_bank_accounts for select using (auth.uid() is not null);
drop policy if exists cba_admin_all on company_bank_accounts;
create policy cba_admin_all on company_bank_accounts for all using (public.is_admin()) with check (public.is_admin());

-- ── cheques ──────────────────────────────────────────────────────────────────
create table if not exists cheques (
  id              uuid primary key default gen_random_uuid(),
  status          cheque_status not null default 'draft',

  -- extracted / entered fields (§B1) — dealer_name is free text
  cheque_number   text,
  cheque_date     date,
  amount          numeric(12,2),
  amount_in_words text,
  dealer_name     text,
  bank_name       text,           -- drawee (dealer's) bank
  branch          text,
  ifsc            text,
  account_number  text,
  micr_code       text,
  payee_name      text,
  notes           text,

  -- workflow
  uploaded_by     uuid references profiles(id),
  upload_date     timestamptz not null default now(),
  submitted_at    timestamptz,
  decided_by      uuid references profiles(id),
  decided_at      timestamptz,
  decision_reason text,

  -- bank tracking (admin only)
  our_bank_account_id uuid references company_bank_accounts(id),
  presented_date  date,
  cleared_date    date,           -- passed-on date, or bounce date when bounced
  bounce_reason   text,

  -- extraction provenance (Phase 2: 'ai' | 'ocr'; Phase 1: 'manual')
  extraction_source text not null default 'manual',
  extracted_raw   jsonb,

  created_at      timestamptz not null default now()
);
create index if not exists cheques_status_idx on cheques (status);
create index if not exists cheques_uploaded_by_idx on cheques (uploaded_by);
create index if not exists cheques_cheque_date_idx on cheques (cheque_date);

alter table cheques enable row level security;
-- ALL authenticated staff can READ every cheque (D1 = all managers see all).
drop policy if exists cheques_select on cheques;
create policy cheques_select on cheques for select using (auth.uid() is not null);
-- Admin may do anything directly; managers write only through the RPCs below.
drop policy if exists cheques_admin_all on cheques;
create policy cheques_admin_all on cheques for all using (public.is_admin()) with check (public.is_admin());

-- ── editable-field applier (shared by create/update) ─────────────────────────
-- Only the manager-editable fields; workflow/bank fields are never set here.
create or replace function public.apply_cheque_fields(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  update cheques set
    cheque_number   = case when p ? 'cheque_number'   then nullif(p->>'cheque_number','')          else cheque_number end,
    cheque_date     = case when p ? 'cheque_date'     then nullif(p->>'cheque_date','')::date       else cheque_date end,
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

-- ── Manager/admin: create a draft cheque ─────────────────────────────────────
create or replace function public.create_cheque(p jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_src text;
begin
  if auth.uid() is not null and not (public.is_manager() or public.is_admin()) then
    raise exception 'create_cheque: staff only' using errcode = 'insufficient_privilege';
  end if;
  v_src := coalesce(nullif(p->>'extraction_source',''), 'manual');
  insert into cheques (status, uploaded_by, extraction_source, extracted_raw)
  values ('draft', auth.uid(), v_src, p->'extracted_raw')
  returning id into v_id;
  perform public.apply_cheque_fields(v_id, p);
  perform public.write_audit('cheque_created', 'cheques', v_id::text, null, p, null);
  return v_id;
end;
$$;
grant execute on function public.create_cheque(jsonb) to authenticated;

-- ── Manager/admin: edit a draft or rejected cheque (own, or admin) ───────────
create or replace function public.update_cheque_draft(p_id uuid, p jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status not in ('draft', 'rejected') then
    raise exception 'only draft or rejected cheques can be edited (this one is %)', c.status;
  end if;
  if auth.uid() is not null and not public.is_admin() and c.uploaded_by <> auth.uid() then
    raise exception 'you can only edit cheques you uploaded' using errcode = 'insufficient_privilege';
  end if;
  perform public.apply_cheque_fields(p_id, p);
  perform public.write_audit('cheque_updated', 'cheques', p_id::text, null, p, null);
end;
$$;
grant execute on function public.update_cheque_draft(uuid, jsonb) to authenticated;

-- ── Manager/admin: submit for approval (draft|rejected → pending) ────────────
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
  update cheques
    set status = 'pending', submitted_at = now(),
        decided_by = null, decided_at = null, decision_reason = null
    where id = p_id;
  perform public.write_audit('cheque_submitted', 'cheques', p_id::text, null, null, null);
end;
$$;
grant execute on function public.submit_cheque(uuid) to authenticated;

-- ── Admin: approve (→ submitted) or reject (→ rejected, reason required) ──────
create or replace function public.decide_cheque(p_id uuid, p_approve boolean, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'decide_cheque: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status <> 'pending' then raise exception 'cheque % is not pending approval', p_id; end if;
  if not p_approve and coalesce(trim(p_reason), '') = '' then
    raise exception 'rejection requires a reason';
  end if;
  update cheques
    set status = case when p_approve then 'submitted' else 'rejected' end::cheque_status,
        decided_by = auth.uid(), decided_at = now(),
        decision_reason = case when p_approve then null else p_reason end
    where id = p_id;
  perform public.write_audit(
    case when p_approve then 'cheque_approved' else 'cheque_rejected' end,
    'cheques', p_id::text, null, null, p_reason);
end;
$$;
grant execute on function public.decide_cheque(uuid, boolean, text) to authenticated;

-- ── Admin: record bank presentation (submitted → presented) ──────────────────
create or replace function public.record_cheque_presented(p_id uuid, p_bank_account uuid, p_date date)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'record_cheque_presented: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status <> 'submitted' then raise exception 'only approved cheques can be presented (cheque % is %)', p_id, c.status; end if;
  update cheques
    set status = 'presented',
        our_bank_account_id = p_bank_account,
        presented_date = coalesce(p_date, current_date)
    where id = p_id;
  perform public.write_audit('cheque_presented', 'cheques', p_id::text, null,
    jsonb_build_object('our_bank_account_id', p_bank_account, 'presented_date', p_date), null);
end;
$$;
grant execute on function public.record_cheque_presented(uuid, uuid, date) to authenticated;

-- ── Admin: mark outcome (presented → passed | bounced) ───────────────────────
create or replace function public.mark_cheque_outcome(p_id uuid, p_passed boolean, p_date date, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare c cheques%rowtype;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'mark_cheque_outcome: admin only' using errcode = 'insufficient_privilege';
  end if;
  select * into c from cheques where id = p_id for update;
  if c.id is null then raise exception 'cheque % not found', p_id; end if;
  if c.status <> 'presented' then raise exception 'only presented cheques can be marked passed or bounced (cheque % is %)', p_id, c.status; end if;
  if not p_passed and coalesce(trim(p_reason), '') = '' then
    raise exception 'a bounce requires a reason';
  end if;
  update cheques
    set status = case when p_passed then 'passed' else 'bounced' end::cheque_status,
        cleared_date = coalesce(p_date, current_date),
        bounce_reason = case when p_passed then null else p_reason end
    where id = p_id;
  perform public.write_audit(
    case when p_passed then 'cheque_passed' else 'cheque_bounced' end,
    'cheques', p_id::text, null,
    jsonb_build_object('date', p_date), p_reason);
end;
$$;
grant execute on function public.mark_cheque_outcome(uuid, boolean, date, text) to authenticated;
