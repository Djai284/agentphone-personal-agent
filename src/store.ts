// SQLite persistence. The MCP server and the CLI can run at the same time against the same file,
// so every state change that must happen exactly once (dialing, finalizing, texting) goes through a
// conditional UPDATE and checks whether it won.
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  type CallStatus,
  type CallView,
  type Outcome,
  type PlaceCallInput,
  Outcome as OutcomeSchema,
  PlaceCallInput as PlaceCallInputSchema,
  TranscriptTurn,
} from "./schemas.ts";
import { z } from "zod";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS calls (
  id               TEXT PRIMARY KEY,
  idempotency_key  TEXT NOT NULL UNIQUE,
  request_hash     TEXT NOT NULL,
  request_json     TEXT NOT NULL,
  status           TEXT NOT NULL,
  provider_call_id TEXT,
  to_number        TEXT NOT NULL,
  recipient        TEXT,
  task             TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  started_at       TEXT,
  ended_at         TEXT,
  duration_seconds REAL,
  end_reason       TEXT,
  error            TEXT,
  transcript_json  TEXT NOT NULL DEFAULT '[]',
  outcome_json     TEXT,
  finalize_lease   TEXT,
  sms_status       TEXT NOT NULL DEFAULT 'not_sent',
  sms_to           TEXT,
  sms_error        TEXT,
  sms_message_id   TEXT
);
CREATE TABLE IF NOT EXISTS call_events (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  call_id TEXT NOT NULL REFERENCES calls(id),
  at      TEXT NOT NULL,
  type    TEXT NOT NULL,
  detail  TEXT
);
CREATE INDEX IF NOT EXISTS calls_status ON calls(status);
CREATE INDEX IF NOT EXISTS call_events_call ON call_events(call_id);
`;

const LEASE_MS = 3 * 60_000;
const now = () => new Date().toISOString();

const Row = z.object({
  id: z.string(),
  idempotency_key: z.string(),
  request_hash: z.string(),
  request_json: z.string(),
  status: z.string(),
  provider_call_id: z.string().nullable(),
  to_number: z.string(),
  recipient: z.string().nullable(),
  task: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  started_at: z.string().nullable(),
  ended_at: z.string().nullable(),
  duration_seconds: z.number().nullable(),
  end_reason: z.string().nullable(),
  error: z.string().nullable(),
  transcript_json: z.string(),
  outcome_json: z.string().nullable(),
  finalize_lease: z.string().nullable(),
  sms_status: z.string(),
  sms_to: z.string().nullable(),
  sms_error: z.string().nullable(),
  sms_message_id: z.string().nullable(),
});
export type CallRow = z.infer<typeof Row>;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(SCHEMA);
  }

  /** Insert a new call, or return the existing one for this idempotency key. */
  createOrGet(input: PlaceCallInput, requestHash: string): { row: CallRow; created: boolean } {
    const id = `call_${randomBytes(8).toString("hex")}`;
    const t = now();
    const result = this.db
      .prepare(
        `INSERT INTO calls (id, idempotency_key, request_hash, request_json, status, to_number, recipient, task, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?)
         ON CONFLICT(idempotency_key) DO NOTHING`,
      )
      .run(id, input.idempotency_key, requestHash, JSON.stringify(input), input.to, input.recipient ?? null, input.task, t, t);
    const created = result.changes === 1;
    if (created) this.event(id, "created");
    return { row: this.getByKey(input.idempotency_key)!, created };
  }

  get(id: string): CallRow | undefined {
    const r = this.db.prepare("SELECT * FROM calls WHERE id = ?").get(id);
    return r ? Row.parse(r) : undefined;
  }

  getByKey(key: string): CallRow | undefined {
    const r = this.db.prepare("SELECT * FROM calls WHERE idempotency_key = ?").get(key);
    return r ? Row.parse(r) : undefined;
  }

  list(limit = 20): CallRow[] {
    return this.db.prepare("SELECT * FROM calls ORDER BY created_at DESC LIMIT ?").all(limit).map((r) => Row.parse(r));
  }

  /** Calls that still need polling or finalizing. */
  pending(): CallRow[] {
    return this.db
      .prepare("SELECT * FROM calls WHERE status IN ('dialing', 'in_progress', 'analyzing') ORDER BY created_at")
      .all()
      .map((r) => Row.parse(r));
  }

  request(row: CallRow): PlaceCallInput {
    return PlaceCallInputSchema.parse(JSON.parse(row.request_json));
  }

  /**
   * Move to `to` only if the call is currently in one of `from`. Returns whether this caller won,
   * which is what makes dialing and finalizing safe across processes.
   */
  transition(id: string, from: CallStatus[], to: CallStatus, fields: Partial<CallRow> = {}): boolean {
    const sets = Object.keys(fields).map((k) => `${k} = ?`);
    const result = this.db
      .prepare(
        `UPDATE calls SET status = ?, updated_at = ?${sets.map((s) => `, ${s}`).join("")}
         WHERE id = ? AND status IN (${from.map(() => "?").join(", ")})`,
      )
      .run(to, now(), ...(Object.values(fields) as (string | number | null)[]), id, ...from);
    if (result.changes === 1) this.event(id, "status", `${to}${fields.error ? `: ${fields.error}` : ""}`);
    return result.changes === 1;
  }

  update(id: string, fields: Partial<CallRow>): void {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    this.db
      .prepare(`UPDATE calls SET ${keys.map((k) => `${k} = ?`).join(", ")}, updated_at = ? WHERE id = ?`)
      .run(...(Object.values(fields) as (string | number | null)[]), now(), id);
  }

  /** Claim the right to analyze + notify an ended call. Expired leases can be re-claimed after a crash. */
  claimFinalize(id: string): boolean {
    const expired = new Date(Date.now() - LEASE_MS).toISOString();
    const result = this.db
      .prepare(
        `UPDATE calls SET finalize_lease = ? WHERE id = ? AND status = 'analyzing'
         AND (finalize_lease IS NULL OR finalize_lease < ?)`,
      )
      .run(now(), id, expired);
    return result.changes === 1;
  }

  /** Claim the single SMS send for a call. */
  claimSms(id: string, to: string): boolean {
    const result = this.db
      .prepare("UPDATE calls SET sms_status = 'sending', sms_to = ? WHERE id = ? AND sms_status = 'not_sent'")
      .run(to, id);
    return result.changes === 1;
  }

  event(callId: string, type: string, detail?: string): void {
    this.db.prepare("INSERT INTO call_events (call_id, at, type, detail) VALUES (?, ?, ?, ?)").run(callId, now(), type, detail ?? null);
  }

  events(callId: string): { at: string; type: string; detail: string | null }[] {
    return this.db
      .prepare("SELECT at, type, detail FROM call_events WHERE call_id = ? ORDER BY id")
      .all(callId) as { at: string; type: string; detail: string | null }[];
  }
}

export function toView(row: CallRow): CallView {
  return {
    call_id: row.id,
    status: row.status as CallStatus,
    to: row.to_number,
    recipient: row.recipient,
    task: row.task,
    created_at: row.created_at,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_seconds: row.duration_seconds,
    end_reason: row.end_reason,
    error: row.error,
    transcript: z.array(TranscriptTurn).parse(JSON.parse(row.transcript_json)),
    outcome: row.outcome_json ? (OutcomeSchema.parse(JSON.parse(row.outcome_json)) satisfies Outcome) : null,
    sms: {
      // 'sending' is an internal claim state; report it as not yet sent.
      status: row.sms_status === "sending" ? "not_sent" : (row.sms_status as CallView["sms"]["status"]),
      to: row.sms_to,
      error: row.sms_error,
    },
  };
}
