-- ============================================================================
-- 0013_worker_media.sql — let the manager who created a pending worker persist
-- the storage paths of the photo / id proof they just uploaded (they can't
-- UPDATE the workers row directly via RLS). Admins may set media for anyone.
-- ============================================================================

create or replace function public.set_worker_media(p_worker uuid, p_photo_path text, p_id_proof_path text)
returns void language plpgsql security definer set search_path = public as $$
declare w workers%rowtype;
begin
  select * into w from workers where id = p_worker;
  if w.id is null then raise exception 'worker % not found', p_worker; end if;

  if not public.is_admin()
     and not (public.is_manager() and w.created_by = auth.uid() and w.approval_status = 'pending') then
    raise exception 'not allowed to set media for this worker' using errcode = 'insufficient_privilege';
  end if;

  update workers set
    photo_path    = coalesce(nullif(p_photo_path, ''), photo_path),
    id_proof_path = coalesce(nullif(p_id_proof_path, ''), id_proof_path)
  where id = p_worker;
end;
$$;
grant execute on function public.set_worker_media(uuid, text, text) to authenticated;
