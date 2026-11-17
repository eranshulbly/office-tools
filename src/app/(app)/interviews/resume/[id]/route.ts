import { NextResponse } from "next/server";
import { getProfile } from "@/lib/auth";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getObject } from "@/lib/storage/s3";

/**
 * Serve a candidate's resume from S3.
 *
 * Streamed through the app rather than handed out as a presigned URL: a
 * presigned link works for anyone who has it until it expires, whereas this
 * checks the caller's session and role on every single request. Resumes are
 * personal data and the volume is tiny, so the extra hop costs nothing.
 *
 * The caller supplies a candidate id, never an object key — the key is looked
 * up here, so no one can probe the bucket by guessing paths.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const profile = await getProfile();
  if (!profile) return new NextResponse("Not signed in", { status: 401 });
  if (profile.role !== "admin" && profile.role !== "manager") {
    return new NextResponse("Not permitted", { status: 403 });
  }

  const { id } = await params;
  const db = await createSupabaseServerClient();
  const { data } = await db
    .from("candidates")
    .select("resume_path, resume_name, resume_mime")
    .eq("id", id)
    .maybeSingle();

  const row = data as {
    resume_path: string | null;
    resume_name: string | null;
    resume_mime: string | null;
  } | null;
  if (!row?.resume_path) return new NextResponse("No resume on file", { status: 404 });

  const obj = await getObject(row.resume_path);
  if (!obj) return new NextResponse("Resume is missing from storage", { status: 404 });

  return new NextResponse(new Uint8Array(obj.body), {
    headers: {
      "Content-Type": obj.contentType || row.resume_mime || "application/octet-stream",
      // inline so PDFs open in the browser; the original name is restored here
      "Content-Disposition": `inline; filename="${(row.resume_name || "resume").replace(/"/g, "")}"`,
      // personal data — never let a shared cache hold it
      "Cache-Control": "private, no-store",
    },
  });
}
