import { mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/**
 * Durable store-and-forward spool. Each incoming batch of punches is written to
 * its own file BEFORE the device is acknowledged, so a punch is never lost even
 * if Supabase (or the internet) is down. The background drainer sends each file
 * and deletes it only on confirmed success. Re-sending after a crash is safe:
 * raw_punches has a unique index and inserts ignore duplicates.
 *
 * A plain spool directory (not SQLite) keeps the gateway dependency-free and
 * trivial to run on a Windows office PC — the store-and-forward guarantee is the
 * requirement, and an fsync'd append-then-rename gives us that.
 */
export class Spool {
  constructor(dir) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    this.seq = 0;
  }

  // Write atomically: temp file then rename (rename is atomic on the same fs).
  enqueue(serial, records) {
    if (!records.length) return;
    this.seq += 1;
    const stamp = `${Date.now()}-${process.pid}-${this.seq}`;
    const tmp = join(this.dir, `.${stamp}.tmp`);
    const final = join(this.dir, `${stamp}.json`);
    writeFileSync(tmp, JSON.stringify({ serial, records }), "utf8");
    renameSync(tmp, final);
  }

  // Oldest-first list of pending batch files.
  pending() {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => join(this.dir, f));
  }

  read(file) {
    return JSON.parse(readFileSync(file, "utf8"));
  }

  ack(file) {
    try {
      unlinkSync(file);
    } catch {
      /* already gone */
    }
  }

  depth() {
    return this.pending().length;
  }
}
