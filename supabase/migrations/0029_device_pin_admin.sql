-- ============================================================================
-- 0029_device_pin_admin.sql — assign biometric device PINs from the app.
--
-- The terminal only knows a numeric device_user_id (the PIN enrolled on it);
-- the gateway resolves it to a worker AT INGEST. A worker with no PIN yet gets
-- punches stored with worker_id = NULL, and raw_punches is append-only (no
-- UPDATE allowed), so those punches could never be linked afterwards.
--
-- Fix: dedupe_punch_times now ALSO picks up unlinked punches whose
-- device_user_id equals the worker's current PIN. device_user_id is unique on
-- workers, so a punch can never be attributed to two people. Assigning a PIN
-- therefore backfills that person's earlier punches on the next recompute.
-- Idempotent.
-- ============================================================================

create or replace function public.dedupe_punch_times(p_worker uuid, p_day date, p_window_min numeric)
returns timestamptz[] language plpgsql stable security definer set search_path = public as $$
declare
  r record;
  kept timestamptz[] := '{}';
  last_kept timestamptz;
  tz text := public.warehouse_tz();
  v_pin int;
begin
  select device_user_id into v_pin from workers where id = p_worker;
  for r in
    select rp.device_ts from raw_punches rp
    where (
        rp.worker_id = p_worker
        -- unlinked punches from this worker's terminal PIN (PIN is unique)
        or (rp.worker_id is null and v_pin is not null and rp.device_user_id = v_pin)
      )
      and (rp.device_ts at time zone tz)::date = p_day
    order by rp.device_ts
  loop
    if last_kept is null
       or r.device_ts >= last_kept + make_interval(mins => p_window_min::int) then
      kept := array_append(kept, r.device_ts);
      last_kept := r.device_ts;
    end if;
  end loop;
  return kept;
end;
$$;

-- ── assign / clear a worker's device PIN (admin) ─────────────────────────────
create or replace function public.admin_set_device_pin(p_worker uuid, p_pin int)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'admin_set_device_pin: admin only' using errcode = 'insufficient_privilege';
  end if;
  if p_pin is not null and p_pin <= 0 then
    raise exception 'device PIN must be a positive number';
  end if;
  if p_pin is not null and exists (
    select 1 from workers where device_user_id = p_pin and id <> p_worker
  ) then
    raise exception 'PIN % is already assigned to another employee', p_pin;
  end if;
  update workers set device_user_id = p_pin where id = p_worker;
  if not found then raise exception 'worker % not found', p_worker; end if;
  perform public.write_audit('worker_device_pin_set', 'workers', p_worker::text, null,
    jsonb_build_object('device_user_id', p_pin), null);
end;
$$;
grant execute on function public.admin_set_device_pin(uuid, int) to authenticated;

-- ── PINs seen on the terminal that aren't mapped to anyone yet ───────────────
create or replace function public.unlinked_punch_pins()
returns table (pin int, punches bigint, first_seen timestamptz, last_seen timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'unlinked_punch_pins: admin only' using errcode = 'insufficient_privilege';
  end if;
  return query
    select rp.device_user_id, count(*)::bigint, min(rp.device_ts), max(rp.device_ts)
    from raw_punches rp
    where rp.worker_id is null
    group by rp.device_user_id
    order by max(rp.device_ts) desc;
end;
$$;
grant execute on function public.unlinked_punch_pins() to authenticated;
