/** The Postgres from docker-compose.yml (`npm run db:up`). Used when DATABASE_URL isn't set. */
export const DEFAULT_DATABASE_URL = "postgresql://callagent:callagent@localhost:5434/callagent";
