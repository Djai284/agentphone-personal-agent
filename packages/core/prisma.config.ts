import { config } from "dotenv";
import { fileURLToPath } from "node:url";
import { defineConfig } from "prisma/config";
import { DEFAULT_DATABASE_URL } from "./src/db/defaults.ts";

// The repo keeps one .env at its root, shared by every app.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)), quiet: true });

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  // Defaulted so `npm install` (which generates the client) works before any .env exists.
  datasource: { url: process.env.DATABASE_URL || DEFAULT_DATABASE_URL },
});
