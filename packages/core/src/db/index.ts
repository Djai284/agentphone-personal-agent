import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/client.ts";

export { DEFAULT_DATABASE_URL } from "./defaults.ts";
export { CallRepository, type CallUpdate, type NewCall } from "./repository.ts";
export { CallSource, CallStatus, SmsStatus } from "./generated/enums.ts";
export type { Call, CallEvent, Prisma, PrismaClient } from "./generated/client.ts";

export function createDb(databaseUrl: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}
