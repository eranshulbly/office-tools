"use client";

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, Section, Badge, Table, Th, Td, Empty, FormError, FormOk } from "@/components/ui";
import { setDevicePin, recomputeRange, syncDeviceUsers } from "./actions";

export type PinWorker = {
  id: string;
  employee_code: string;
  full_name: string;
  device_user_id: number | null;
  is_active: boolean;
};
export type UnlinkedPin = { pin: number; punches: number; first_seen: string; last_seen: string };
export type DeviceUser = { device_serial: string; pin: number; name: string | null; updated_at: string };

const inputClass = "w-28 rounded border border-line px-2.5 py-1.5 text-sm tabular";
const BTN =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-transparent bg-[var(--color-brand)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)] disabled:opacity-50";
const BTN_OUTLINE =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)] disabled:opacity-50";

function dt(v: string): string {
  return v ? new Date(v).toLocaleString("en-IN") : "—";
}

export function DevicePins({
  workers,
  unlinked,
  deviceUsers,
  serial,
  error: loadError,
}: {
  workers: PinWorker[];
  unlinked: UnlinkedPin[];
  deviceUsers: DeviceUser[];
  serial?: string;
  error?: string;
}) {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [picks, setPicks] = useState<Record<number, string>>({}); // device PIN -> worker id
  const [error, setError] = useState<string | undefined>(loadError);
  const [ok, setOk] = useState<string>();
  const [pending, startTransition] = useTransition();

  // Which employee currently holds each device PIN.
  const workerByPin = useMemo(() => {
    const m = new Map<number, PinWorker>();
    for (const w of workers) if (w.device_user_id != null) m.set(w.device_user_id, w);
    return m;
  }, [workers]);

  function sync() {
    setError(undefined); setOk(undefined);
    if (!serial) { setError("No terminal has contacted the server yet."); return; }
    startTransition(async () => {
      const res = await syncDeviceUsers(serial);
      if (res.error) { setError(res.error); return; }
      setOk("Asked the terminal for its user list — it replies within a few seconds. Refresh shortly.");
      setTimeout(() => router.refresh(), 6000);
    });
  }

  function assign(pin: number) {
    setError(undefined); setOk(undefined);
    const workerId = picks[pin];
    if (!workerId) { setError("Pick an employee first."); return; }
    startTransition(async () => {
      const res = await setDevicePin(workerId, pin);
      if (res.error) { setError(res.error); return; }
      const w = workers.find((x) => x.id === workerId);
      setPicks((p) => { const next = { ...p }; delete next[pin]; return next; });
      setOk(`PIN ${pin} mapped to ${w?.full_name ?? "employee"}.`);
      router.refresh();
    });
  }

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return workers;
    return workers.filter(
      (w) =>
        w.full_name.toLowerCase().includes(s) ||
        w.employee_code.toLowerCase().includes(s) ||
        String(w.device_user_id ?? "").includes(s)
    );
  }, [workers, q]);

  const missing = workers.filter((w) => w.device_user_id == null).length;

  function save(w: PinWorker) {
    setError(undefined); setOk(undefined);
    const raw = (drafts[w.id] ?? "").trim();
    let pin: number | null = null;
    if (raw !== "") {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) { setError(`"${raw}" isn't a valid PIN — use a whole number from the terminal.`); return; }
      pin = n;
    }
    startTransition(async () => {
      const res = await setDevicePin(w.id, pin);
      if (res.error) { setError(res.error); return; }
      setDrafts((d) => { const next = { ...d }; delete next[w.id]; return next; });
      setOk(pin == null ? `Cleared PIN for ${w.full_name}.` : `PIN ${pin} assigned to ${w.full_name}.`);
      router.refresh();
    });
  }

  function backfill() {
    setError(undefined); setOk(undefined);
    // Recompute from the earliest unlinked punch (or the last 60 days) to today.
    const earliest = unlinked.map((u) => u.first_seen).sort()[0];
    const from = (earliest ? new Date(earliest) : new Date(Date.now() - 60 * 864e5))
      .toLocaleDateString("en-CA");
    const to = new Date().toLocaleDateString("en-CA");
    startTransition(async () => {
      const res = await recomputeRange(from, to);
      if (res.error) { setError(res.error); return; }
      setOk(`Attendance recomputed from ${from} to ${to} — newly-mapped punches are now counted.`);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <FormError message={error} />
        {ok && <FormOk message={ok} />}
      </div>

      {missing > 0 && (
        <div className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-[var(--color-warn)]">
          {missing} active employee{missing === 1 ? " has" : "s have"} no device PIN — their punches will not be counted until you map them below.
        </div>
      )}

      <Section title={`Users enrolled on the terminal (${deviceUsers.length})`}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-muted">
            Pulled from the machine itself — its User ID and the name enrolled against it. Match each to an employee and the
            PIN is set for you. Fingerprints stay on the device; only the ID and name are read.
          </p>
          <button type="button" className={BTN_OUTLINE} onClick={sync} disabled={pending || !serial}>
            {pending ? "Working…" : "Sync users from device"}
          </button>
        </div>
        {deviceUsers.length === 0 ? (
          <Empty>
            No user list yet. Press <span className="font-medium">Sync users from device</span> — the terminal replies within a few seconds.
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Device User ID</Th>
                <Th>Name on device</Th>
                <Th>Mapped to</Th>
                <Th></Th>
              </tr>
            }
          >
            {deviceUsers.map((u) => {
              const mapped = workerByPin.get(u.pin);
              return (
                <tr key={`${u.device_serial}-${u.pin}`}>
                  <Td className="tabular font-semibold text-ink">{u.pin}</Td>
                  <Td>{u.name || <span className="text-muted">— (no name on device)</span>}</Td>
                  <Td>
                    {mapped
                      ? <span className="font-medium text-ink">{mapped.full_name} <span className="text-muted">({mapped.employee_code})</span></span>
                      : <Badge tone="warn">Not mapped</Badge>}
                  </Td>
                  <Td className="text-right">
                    {mapped ? (
                      <span className="text-xs text-muted">✓</span>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <select
                          value={picks[u.pin] ?? ""}
                          onChange={(e) => setPicks((p) => ({ ...p, [u.pin]: e.target.value }))}
                          className="rounded border border-line px-2 py-1.5 text-sm"
                        >
                          <option value="">Choose employee…</option>
                          {workers.map((w) => (
                            <option key={w.id} value={w.id}>
                              {w.full_name} ({w.employee_code}){w.device_user_id != null ? ` — has PIN ${w.device_user_id}` : ""}
                            </option>
                          ))}
                        </select>
                        <button type="button" className={BTN} onClick={() => assign(u.pin)} disabled={pending}>
                          Map
                        </button>
                      </div>
                    )}
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      <Section title={`Unmapped PINs seen on the terminal (${unlinked.length})`}>
        {unlinked.length === 0 ? (
          <Empty>Every punch received so far is mapped to an employee.</Empty>
        ) : (
          <>
            <p className="mb-3 text-xs text-muted">
              These User IDs have punched on the machine but aren&apos;t assigned to anyone. Find who they belong to and enter the
              PIN against that employee below — earlier punches are backfilled automatically.
            </p>
            <Table
              head={
                <tr>
                  <Th>PIN</Th>
                  <Th className="text-right">Punches</Th>
                  <Th>First seen</Th>
                  <Th>Last seen</Th>
                </tr>
              }
            >
              {unlinked.map((u) => (
                <tr key={u.pin}>
                  <Td className="tabular font-semibold text-ink">{u.pin}</Td>
                  <Td className="text-right tabular">{u.punches}</Td>
                  <Td className="text-muted text-xs">{dt(u.first_seen)}</Td>
                  <Td className="text-muted text-xs">{dt(u.last_seen)}</Td>
                </tr>
              ))}
            </Table>
            <div className="mt-3">
              <button type="button" className={BTN_OUTLINE} onClick={backfill} disabled={pending}>
                {pending ? "Working…" : "Recompute attendance (backfill newly-mapped punches)"}
              </button>
            </div>
          </>
        )}
      </Section>

      <Section title={`Employees (${filtered.length})`}>
        <div className="mb-3">
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search name, employee code or PIN…"
            className="w-full max-w-xs rounded-lg border border-line px-3 py-2 text-sm"
          />
        </div>
        {filtered.length === 0 ? (
          <Empty>No employees match your search.</Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Employee</Th>
                <Th>Code</Th>
                <Th>Status</Th>
                <Th>Device PIN</Th>
                <Th></Th>
              </tr>
            }
          >
            {filtered.map((w) => {
              const draft = drafts[w.id];
              const current = w.device_user_id == null ? "" : String(w.device_user_id);
              const value = draft ?? current;
              const dirty = draft !== undefined && draft !== current;
              return (
                <tr key={w.id}>
                  <Td className="font-medium text-ink">{w.full_name}</Td>
                  <Td className="tabular">{w.employee_code}</Td>
                  <Td>
                    {w.device_user_id == null
                      ? <Badge tone="warn">No PIN</Badge>
                      : w.is_active ? <Badge tone="ok">Mapped</Badge> : <Badge tone="neutral">Inactive</Badge>}
                  </Td>
                  <Td>
                    <input
                      type="number"
                      min={1}
                      step={1}
                      value={value}
                      placeholder="—"
                      onChange={(e) => setDrafts((d) => ({ ...d, [w.id]: e.target.value }))}
                      className={inputClass}
                    />
                  </Td>
                  <Td className="text-right">
                    <button type="button" className={BTN} onClick={() => save(w)} disabled={pending || !dirty}>
                      Save
                    </button>
                  </Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>

      <Card className="p-4">
        <div className="text-sm font-semibold text-ink">How the PIN works</div>
        <p className="mt-1 text-xs text-muted">
          When you enrol a fingerprint on the terminal you give that person a <span className="text-ink">User ID</span> (a number).
          The machine sends only that number with each punch. The PIN here must be the same number, and it must be unique —
          it is what links a punch to an employee. Change it only if the person is re-enrolled on the device.
        </p>
      </Card>
    </div>
  );
}
