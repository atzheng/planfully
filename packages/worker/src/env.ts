export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  TRIP_DOMAIN: string;
  ADMIN_SECRET: string;
  // Optional: code must run with these unset (CONTRACTS.md section 8).
  ANTHROPIC_API_KEY?: string;
  GOOGLE_MAPS_SERVER_KEY?: string;
}
