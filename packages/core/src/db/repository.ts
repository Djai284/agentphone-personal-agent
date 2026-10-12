// Data access for calls. The MCP server, CLI, and phone server can run at the same time against one
// database, so every state change that must happen exactly once (dialing, finalizing, texting,
// handling a webhook) is a conditional update, and the caller checks whether it won.
import { randomBytes } from "node:crypto";
import { type Call, type CallSource, type CallStatus, Prisma, type PrismaClient } from "./generated/client.ts";

const LEASE_MS = 3 * 60_000;

export type NewCall = {
  idempotencyKey: string;
  requestHash: string;
  request: Prisma.InputJsonValue;
  source: CallSource;
  requester: string;
  toNumber: string;
  recipient: string | null;
  task: string;
};

/** Fields that can be written alongside a status change. */
export type CallUpdate = Omit<Prisma.CallUpdateInput, "status" | "events" | "id">;

const isUniqueViolation = (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";

export class CallRepository {
  constructor(private readonly db: PrismaClient) {}

  /** Insert a new call, or return the existing one for this idempotency key. */
  async createOrGet(data: NewCall): Promise<{ call: Call; created: boolean }> {
    try {
      const call = await this.db.call.create({
        data: { id: `call_${randomBytes(8).toString("hex")}`, ...data, events: { create: { type: "created" } } },
      });
      return { call, created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return { call: (await this.getByKey(data.idempotencyKey))!, created: false };
    }
  }

  get(id: string) {
    return this.db.call.findUnique({ where: { id } });
  }

  getByKey(idempotencyKey: string) {
    return this.db.call.findUnique({ where: { idempotencyKey } });
  }

  getByProviderId(providerCallId: string) {
    return this.db.call.findUnique({ where: { providerCallId } });
  }

  list({ limit = 20, requester }: { limit?: number; requester?: string } = {}) {
    return this.db.call.findMany({ where: requester ? { requester } : {}, orderBy: { createdAt: "desc" }, take: limit });
  }

  /** Calls that still need polling or finalizing. */
  pending() {
    return this.db.call.findMany({ where: { status: { in: ["dialing", "in_progress", "analyzing"] } }, orderBy: { createdAt: "asc" } });
  }

  /**
   * Move to `to` only if the call is currently in one of `from`. Returns whether this caller won,
   * which is what makes dialing and finalizing safe across processes.
   */
  async transition(id: string, from: CallStatus[], to: CallStatus, fields: CallUpdate = {}): Promise<boolean> {
    const { count } = await this.db.call.updateMany({ where: { id, status: { in: from } }, data: { ...fields, status: to } as Prisma.CallUpdateManyMutationInput });
    if (count === 1) await this.event(id, "status", `${to}${typeof fields.error === "string" ? `: ${fields.error}` : ""}`);
    return count === 1;
  }

  async update(id: string, fields: CallUpdate): Promise<void> {
    await this.db.call.update({ where: { id }, data: fields });
  }

  /** Claim the right to analyze + notify an ended call. Expired leases can be re-claimed after a crash. */
  async claimFinalize(id: string): Promise<boolean> {
    const expired = new Date(Date.now() - LEASE_MS);
    const { count } = await this.db.call.updateMany({
      where: { id, status: "analyzing", OR: [{ finalizeLease: null }, { finalizeLease: { lt: expired } }] },
      data: { finalizeLease: new Date() },
    });
    return count === 1;
  }

  /** Claim the single result text for a call. */
  async claimSms(id: string, to: string): Promise<boolean> {
    const { count } = await this.db.call.updateMany({ where: { id, smsStatus: "not_sent" }, data: { smsStatus: "sending", smsTo: to } });
    return count === 1;
  }

  /** Record a webhook delivery; false if it was already handled (AgentPhone retries deliveries). */
  async claimDelivery(id: string, event: string): Promise<boolean> {
    try {
      await this.db.webhookDelivery.create({ data: { id, event } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }

  /** Forget a delivery so a retry can redo it (used when handling failed). */
  async releaseDelivery(id: string): Promise<void> {
    await this.db.webhookDelivery.deleteMany({ where: { id } });
  }

  async event(callId: string, type: string, detail?: string): Promise<void> {
    await this.db.callEvent.create({ data: { callId, type, detail: detail ?? null } });
  }

  events(callId: string) {
    return this.db.callEvent.findMany({ where: { callId }, orderBy: { id: "asc" } });
  }
}
