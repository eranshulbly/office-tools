import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { type Candidate, CANDIDATE_STATUS_META } from "@/lib/types";
import {
  PageHeader, Card, Section, Badge, Table, Th, Td, Empty,
} from "@/components/ui";
import { CandidateForm } from "./CandidateForm";
import { StatusButtons } from "./StatusButtons";

export const dynamic = "force-dynamic";

function d(v: string | null): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

function size(bytes: number | null): string {
  if (!bytes) return "";
  return bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default async function InterviewsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string }>;
}) {
  await requireFeature("candidates");
  const { q = "", status = "" } = await searchParams;
  const db = await createSupabaseServerClient();

  const [candRes, profilesRes, roundsRes] = await Promise.all([
    db.from("candidates").select("*").order("created_at", { ascending: false }),
    db.from("profiles").select("id, full_name"),
    // Just the ids — enough to count rounds per candidate without pulling every
    // note into a list view that never displays them.
    db.from("interview_rounds").select("candidate_id, round_no"),
  ]);

  const all = (candRes.data ?? []) as Candidate[];

  /**
   * Search and status filter.
   *
   * Applied in TypeScript rather than SQL: matching across several columns
   * needs an OR, which the query builder doesn't express, and the page already
   * loads every candidate. If this grows past a few thousand rows, push it into
   * SQL with a full-text index rather than fetching more.
   */
  const needle = q.trim().toLowerCase();
  const candidates = all.filter((c) => {
    if (status && c.status !== status) return false;
    if (!needle) return true;
    return [c.full_name, c.area, c.reference, c.position, c.phone]
      .some((f) => (f ?? "").toLowerCase().includes(needle));
  });

  // Areas already in use — offered as suggestions on the add form so the same
  // place doesn't get typed three different ways.
  const areas = [...new Set(all.map((c) => c.area).filter((a): a is string => !!a))].sort();

  const roundStats = new Map<string, { notes: number; latest: number }>();
  for (const r of (roundsRes.data ?? []) as { candidate_id: string; round_no: number }[]) {
    const s = roundStats.get(r.candidate_id) ?? { notes: 0, latest: 0 };
    s.notes += 1;
    s.latest = Math.max(s.latest, r.round_no);
    roundStats.set(r.candidate_id, s);
  }
  const nameById = new Map<string, string>(
    (profilesRes.data ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name])
  );

  const count = (s: Candidate["status"]) => all.filter((c) => c.status === s).length;

  return (
    <div>
      <PageHeader
        title="Candidates"
        subtitle="Add a candidate with their resume, then shortlist them for the next round or reject them."
      />

      {candRes.error && (
        <div className="mb-6 rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-[var(--color-danger)]">
          {candRes.error.message}
        </div>
      )}

      <Section title="Add candidate">
        <Card className="p-4">
          <CandidateForm areas={areas} />
        </Card>
      </Section>

      <Section
        title={
          needle || status
            ? `${candidates.length} of ${all.length} candidates`
            : `All candidates (${all.length})`
        }
      >
        {/* Plain GET form: search survives a reload, the URL is shareable, and
            it works without JavaScript. */}
        <form method="GET" className="mb-3 flex flex-wrap items-center gap-2">
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="Search name, area, reference, position or phone…"
            className="w-full max-w-md rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          />
          <select
            name="status"
            defaultValue={status}
            className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-ink"
          >
            <option value="">All statuses</option>
            <option value="new">New</option>
            <option value="shortlisted">Shortlisted</option>
            <option value="rejected">Rejected</option>
          </select>
          <button
            type="submit"
            className="rounded-lg border border-transparent bg-[var(--color-brand)] px-3.5 py-2 text-sm font-medium text-white hover:bg-[var(--color-brand-strong)]"
          >
            Search
          </button>
          {(needle || status) && (
            <a
              href="/interviews"
              className="rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
            >
              Clear
            </a>
          )}
        </form>

        {all.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-2 text-xs text-muted">
            <span>{count("new")} new</span>
            <span>·</span>
            <span>{count("shortlisted")} shortlisted</span>
            <span>·</span>
            <span>{count("rejected")} rejected</span>
          </div>
        )}

        {candidates.length === 0 ? (
          <Empty>
            {needle || status
              ? "No candidates match your search."
              : "No candidates yet. Add the first one above."}
          </Empty>
        ) : (
          <Table
            head={
              <tr>
                <Th>Status</Th>
                <Th>Name</Th>
                <Th>Area</Th>

                <Th>Reference</Th>
                <Th>Position</Th>
                <Th>Phone</Th>
                <Th>Resume</Th>
                <Th>Rounds</Th>
                <Th>Added</Th>
                <Th>Decision</Th>
                <Th>Actions</Th>
              </tr>
            }
          >
            {candidates.map((c) => {
              const meta = CANDIDATE_STATUS_META[c.status];
              return (
                <tr key={c.id}>
                  <Td><Badge tone={meta.tone}>{meta.label}</Badge></Td>
                  <Td>
                    <a
                      href={`/interviews/${c.id}`}
                      className="font-medium text-[var(--color-brand)] underline"
                    >
                      {c.full_name}
                    </a>
                    {c.notes?.trim() && (
                      <div className="text-xs text-muted">{c.notes}</div>
                    )}
                  </Td>
                  <Td className="text-muted">{c.area || "—"}</Td>

                  <Td className="text-muted">{c.reference || "—"}</Td>
                  <Td className="text-muted">{c.position || "—"}</Td>
                  <Td className="text-muted whitespace-nowrap">{c.phone || "—"}</Td>
                  <Td>
                    {c.resume_path ? (
                      <a
                        href={`/interviews/resume/${c.id}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--color-brand)] underline whitespace-nowrap"
                        title={c.resume_name ?? undefined}
                      >
                        View {size(c.resume_size)}
                      </a>
                    ) : (
                      <span className="text-faint">—</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap">
                    {(() => {
                      const s = roundStats.get(c.id);
                      return s ? (
                        <a href={`/interviews/${c.id}`} className="text-[var(--color-brand)] underline">
                          {s.notes} note{s.notes === 1 ? "" : "s"} · R{s.latest}
                        </a>
                      ) : (
                        <a href={`/interviews/${c.id}`} className="text-muted underline">Add notes</a>
                      );
                    })()}
                  </Td>
                  <Td className="text-muted whitespace-nowrap">{d(c.created_at)}</Td>
                  <Td className="text-xs text-muted">
                    {c.status === "new" ? (
                      "—"
                    ) : (
                      <>
                        {c.decision_reason && <div>{c.decision_reason}</div>}
                        <div className="text-faint">
                          {c.decided_by ? nameById.get(c.decided_by) ?? "—" : "—"} · {d(c.decided_at)}
                        </div>
                      </>
                    )}
                  </Td>
                  <Td><StatusButtons id={c.id} status={c.status} /></Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Section>
    </div>
  );
}
