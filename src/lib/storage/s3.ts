import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";

/**
 * S3 object storage.
 *
 * Credentials come from the EC2 instance role (`anshul-ec2`) via the SDK's
 * default provider chain — there are deliberately NO access keys in .env.local.
 * A leaked key is the most common way a bucket gets emptied or mined, and the
 * instance role removes that class of mistake entirely. It also means nothing
 * to rotate.
 *
 * The bucket blocks all public access and encrypts at rest with SSE-S3. Objects
 * are never served directly from S3: the app streams them through an
 * authenticated route, so access is checked per request rather than delegated
 * to a URL that works for anyone holding it.
 *
 * Cost at this volume is negligible — a few hundred resumes is tens of
 * megabytes, well under ₹1/month including requests.
 */

const REGION = process.env.AWS_REGION ?? "ap-south-1";
const BUCKET = process.env.S3_BUCKET ?? "";

declare global {
  // eslint-disable-next-line no-var
  var __s3: S3Client | undefined;
}

// One client per process — it pools connections and caches role credentials,
// so constructing it per request would re-fetch from the metadata service.
export const s3: S3Client = global.__s3 ?? new S3Client({ region: REGION });
if (process.env.NODE_ENV !== "production") global.__s3 = s3;

function bucket(): string {
  if (!BUCKET) throw new Error("S3_BUCKET is not set");
  return BUCKET;
}

export async function putObject(
  key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket(),
      Key: key,
      Body: body,
      ContentType: contentType,
      // Redundant given the bucket default, but explicit so a future bucket
      // without that default still gets encrypted objects.
      ServerSideEncryption: "AES256",
    })
  );
}

/** Fetch an object's bytes. Returns null when the key does not exist. */
export async function getObject(
  key: string
): Promise<{ body: Buffer; contentType?: string } | null> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket(), Key: key }));
    if (!res.Body) return null;
    const bytes = await res.Body.transformToByteArray();
    return { body: Buffer.from(bytes), contentType: res.ContentType };
  } catch (e) {
    const name = (e as { name?: string }).name;
    if (name === "NoSuchKey" || name === "NotFound") return null;
    throw e;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: bucket(), Key: key }));
}
