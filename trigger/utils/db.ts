import postgres from "postgres";

// Create a singleton postgres client for Supabase connection
let sql: ReturnType<typeof postgres> | null = null;

export function getDb() {
  if (!sql) {
    const connectionString = process.env.SUPABASE_DB_STRING;

    if (!connectionString) {
      throw new Error("SUPABASE_DB_STRING environment variable is not set");
    }

    sql = postgres(connectionString, {
      max: 10, // Connection pool size
      idle_timeout: 20,
      connect_timeout: 10,
    });
  }

  return sql;
}
