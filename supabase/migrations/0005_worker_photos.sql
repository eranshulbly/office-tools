-- ============================================================================
-- 0005_worker_photos.sql — worker face photo + identity proof.
-- Photo: private bucket, viewable by any authenticated staff (admin + manager)
--        so both can recognise a worker by face; served via signed URLs.
-- ID proof: private bucket, ADMIN ONLY (sensitive legal document).
-- Both are OPTIONAL at enrollment (nullable columns) — can be added later.
-- ============================================================================

alter table workers add column if not exists photo_path text;
alter table workers add column if not exists id_proof_path text;

-- Private storage buckets. Supabase manages storage.buckets / storage.objects;
-- we just register the buckets and add object policies.
insert into storage.buckets (id, name, public)
values ('worker-photos', 'worker-photos', false),
       ('worker-id-proofs', 'worker-id-proofs', false)
on conflict (id) do nothing;

-- storage.objects already has RLS enabled by Supabase. Policies are OR-combined.

-- Photos: any authenticated staff may READ (admin + manager are the only logins).
drop policy if exists worker_photos_read on storage.objects;
create policy worker_photos_read on storage.objects
  for select to authenticated
  using (bucket_id = 'worker-photos');

-- Photos: only admin may write/replace/remove.
drop policy if exists worker_photos_admin_write on storage.objects;
create policy worker_photos_admin_write on storage.objects
  for all to authenticated
  using (bucket_id = 'worker-photos' and public.is_admin())
  with check (bucket_id = 'worker-photos' and public.is_admin());

-- ID proofs: admin only for everything (read + write).
drop policy if exists worker_id_proofs_admin_only on storage.objects;
create policy worker_id_proofs_admin_only on storage.objects
  for all to authenticated
  using (bucket_id = 'worker-id-proofs' and public.is_admin())
  with check (bucket_id = 'worker-id-proofs' and public.is_admin());
