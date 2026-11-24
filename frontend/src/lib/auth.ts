import { betterAuth } from 'better-auth';
import { Pool } from 'pg';

/** Better Auth server instance backed by PostgreSQL for Facilitator and HR accounts. */
const pool = new Pool({
  connectionString: process.env.BETTER_AUTH_DB_URL,
});

export const auth = betterAuth({
  database: pool,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL || 'http://localhost:3000',
  trustedOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000'],
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 6,
  },
});
