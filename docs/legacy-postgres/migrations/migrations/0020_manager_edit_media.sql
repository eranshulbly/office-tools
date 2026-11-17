-- ============================================================================
-- 0020_manager_edit_media.sql — allow a manager to set the photo / id-proof of an
-- existing worker in ONE OF THEIR GROUPS (not just a pending worker they created).
-- Media isn't a confidential/pay field, so managers may update it directly (their
-- FIELD edits still go through the pending-approval flow). Admins keep full access.
-- Idempotent.
-- ============================================================================

create or replace function public.set_worker_media(p_worker uuid, p_photo_path text, p_id_proof_path text)
returns void language plpgsql security definer set search_path = public as $$
declare w workers%rowtype;
begin
  select * into w from workers where id = p_worker;
  if w.id is null then raise exception 'worker % not found', p_worker; end if;

  if not public.is_admin()
     and not (
       public.is_manager() and (
         (w.created_by = auth.uid() and w.approval_status = 'pending')  -- pending worker they added
         or public.can_disburse_group(w.group_id)                       -- existing worker in their group
       )
     ) then
    raise exception 'not allowed to set media for this worker' using errcode = 'insufficient_privilege';
  end if;

  update workers set
    photo_path    = coalesce(nullif(p_photo_path, ''), photo_path),
    id_proof_path = coalesce(nullif(p_id_proof_path, ''), id_proof_path)
  where id = p_worker;
end;
$$;
grant execute on function public.set_worker_media(uuid, text, text) to authenticated;
