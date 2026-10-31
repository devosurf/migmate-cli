import type { ControlOptions } from "../engine.ts";
import type { RefusalCode, Verb } from "../types.ts";
import type { Store } from "./store.ts";

export interface ControlRequest {
  id: number;
  kind: "stop" | "cancel";
  ownerUuid: string;
  reason: string | null;
  hostId: string;
  pid: number;
  commandId: string;
  requestedAt: string;
  answeredAt: string | null;
  outcome: "stopped" | "cancelled" | RefusalCode | null;
}

const SELECT = `SELECT id, kind, owner_uuid AS ownerUuid, reason, host_id AS hostId,
  pid, command_id AS commandId, requested_at AS requestedAt,
  answered_at AS answeredAt, outcome FROM control_request`;

export function pendingControl(store: Store, ownerUuid: string): ControlRequest | null {
  return (
    (store.db.prepare(`${SELECT} WHERE owner_uuid = ? AND answered_at IS NULL`).get(ownerUuid) as
      ControlRequest | undefined) ?? null
  );
}

export function readControl(store: Store, id: number): ControlRequest | null {
  return (store.db.prepare(`${SELECT} WHERE id = ?`).get(id) as ControlRequest | undefined) ?? null;
}

/** Caller must hold the transaction that checked the current lease and heartbeat. */
export function enqueueControl(
  store: Store,
  ownerUuid: string,
  hostId: string,
  options: ControlOptions,
  now: () => Date,
): ControlRequest {
  const pending = pendingControl(store, ownerUuid);
  if (pending) {
    if (options.kind === "cancel" && pending.kind === "stop") {
      store.db
        .prepare(
          `UPDATE control_request SET kind = 'cancel', reason = ?,
        host_id = ?, pid = ?, command_id = ? WHERE id = ? AND answered_at IS NULL`,
        )
        .run(
          options.reason ?? "Cancelled by operator.",
          hostId,
          process.pid,
          options.commandId,
          pending.id,
        );
      return readControl(store, pending.id)!;
    }
    return pending;
  }
  const inserted = store.db
    .prepare(
      `INSERT INTO control_request
    (kind, owner_uuid, reason, host_id, pid, command_id, requested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      options.kind,
      ownerUuid,
      options.reason ?? null,
      hostId,
      process.pid,
      options.commandId,
      now().toISOString(),
    );
  return readControl(store, Number(inserted.lastInsertRowid))!;
}

/** Answer and evidence commit together, and only the addressed owner may answer. */
export function answerControl(
  store: Store,
  request: ControlRequest,
  outcome: NonNullable<ControlRequest["outcome"]>,
  verb: Verb,
  now: () => Date,
): boolean {
  return store.atomic(() => {
    const answered =
      store.db
        .prepare(
          `UPDATE control_request SET answered_at = ?, outcome = ?
      WHERE id = ? AND owner_uuid = ? AND kind = ? AND answered_at IS NULL
      AND EXISTS (SELECT 1 FROM lease WHERE id = 1 AND owner_uuid = ?)`,
        )
        .run(
          now().toISOString(),
          outcome,
          request.id,
          request.ownerUuid,
          request.kind,
          request.ownerUuid,
        ).changes === 1;
    if (answered)
      store.appendEvent({
        verb,
        phase: verb,
        kind: "control_request",
        payload: { kind: request.kind, outcome, commandId: request.commandId },
      });
    return answered;
  });
}
