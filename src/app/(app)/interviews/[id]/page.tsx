import { notFound } from "next/navigation";
import { requireFeature } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import {
  type Candidate, type InterviewRound,
  CANDIDATE_STATUS_META, ROUND_OUTCOME_META,
} from "@/lib/types";
import { PageHeader, Card, Section, Badge, Empty } from "@/components/ui";
import { RoundForm } from "../RoundForm";
import { StatusButtons } from "../StatusButtons";
import { EditCandidateForm } from "../EditCandidateForm";

export const dynamic = "force-dynamic";

function d(v: string | null): string {
  return v ? new Date(v).toLocaleDateString("en-IN") : "—";
}

export default async function CandidatePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireFeature("candidates");
  const { id } = await params;
  const db = await createSupabaseServerClient();

  const [candRes, roundsRes, profilesRes] = await Promise.all([
    db.from("candidates").select("*").eq("id", id).maybeSingle(),
    db.from("interview_rounds").select("*").eq("candidate_id", id),
    db.from("profiles").select("id, full_name"),
  ]);

  const c = candRes.data as Candidate | null;
  if (!c) notFound();

  const nameById = new Map<string, string>(
    (profilesRes.data ?? []).map((p: { id: string; full_name: string }) => [p.id, p.full_name])
  );

  // Newest round first, and within a round the newest note first — the most
  // recent interview is what you came to read.
  const rounds = ((roundsRes.data ?? []) as InterviewRound[]).sort(
    (a, b) =>
      b.round_no - a.round_no || b.created_at.localeCompare(a.created_at)
  );
  const nextRound = rounds.length ? Math.max(...rounds.map((r) => r.round_no)) + 1 : 1;
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(new Date());

  const meta = CANDIDATE_STATUS_META[c.status];

  return (
    <div>
      <PageHeader
        title={c.full_name}
        subtitle={[c.position, c.reference && `referred by ${c.reference}`, c.phone]
          .filter(Boolean)
          .join(" · ") || "Candidate"}
        actions={
          <a
            href="/interviews"
            className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-3.5 py-2 text-sm font-medium text-ink hover:bg-[var(--color-surface-2)]"
          >
            <span aria-hidden="true">←</span> All candidates
          </a>
        }
      />

      <Card className="mb-6 flex flex-wrap items-center gap-x-4 gap-y-2 p-4">
        <Badge tone={meta.tone}>{meta.label}</Badge>
        <span className="text-sm text-muted">Added {d(c.created_at)}</span>
        {c.resume_path && (
          <a
            href={`/interviews/resume/${c.id}`}
            target="_blank"
            rel="noreferrer"
            className="text-sm text-[var(--color-brand)] underline"
          >
            View resume
          </a>
        )}
        {c.decision_reason && (
          <span className="text-sm text-muted">
            <span className="font-medium text-ink">Decision:</span> {c.decision_reason}
          </span>
        )}
        <span className="ml-auto flex flex-wrap items-center gap-3">
          <StatusButtons id={c.id} status={c.status} />
        </span>
      </Card>

      <Section title="Details">
        <Card className="p-4">
          <EditCandidateForm candidate={c} />
        </Card>
      </Section>

      <Section title={`Add interview notes — round ${nextRound}`}>
        <Card className="p-4">
          <RoundForm candidateId={c.id} nextRound={nextRound} today={today} />
        </Card>
      </Section>

      <Section title={`Interview history (${rounds.length})`}>
        {rounds.length === 0 ? (
          <Empty>No interview notes yet. Add the first round above.</Empty>
        ) : (
          <div className="space-y-3">
            {rounds.map((r) => {
              const om = ROUND_OUTCOME_META[r.outcome];
              return (
                <Card key={r.id} className="p-4">
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="rounded-full bg-[var(--color-brand-soft)] px-2.5 py-0.5 text-xs font-semibold text-[var(--color-brand)]">
                      Round {r.round_no}
                    </span>
                    {r.round_name && <span className="text-sm font-medium text-ink">{r.round_name}</span>}
                    <Badge tone={om.tone}>{om.label}</Badge>
                    <span className="ml-auto text-xs text-muted">
                      {r.interviewer ? `${r.interviewer} · ` : ""}
                      {d(r.interviewed_on ?? r.created_at)}
                    </span>
                  </div>
                  {/* whitespace-pre-wrap so paragraphs typed into the textarea survive */}
                  <p className="whitespace-pre-wrap text-sm text-ink">{r.notes}</p>
                  <div className="mt-2 text-xs text-faint">
                    Recorded by {r.created_by ? nameById.get(r.created_by) ?? "—" : "—"}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </Section>
    </div>
  );
}
