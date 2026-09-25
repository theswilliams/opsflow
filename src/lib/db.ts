import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function create() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set");
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

/** Lazily created singleton (survives Next.js hot reloads). */
export function getDb(): PrismaClient {
  return (globalForPrisma.prisma ??= create());
}

export type Db = PrismaClient;
