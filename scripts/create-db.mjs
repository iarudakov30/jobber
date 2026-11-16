// Creates the database named in DATABASE_URL if it doesn't exist yet. drizzle-kit (unlike
// Prisma) won't create it, so Drizzle apps run this before `drizzle-kit migrate`. Nx loads the
// project's .env, so run it through a target (e.g. `npx nx run wallet:create-db`).
import pg from 'pg';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const target = new URL(url);
const name = decodeURIComponent(target.pathname.slice(1));
const admin = new URL(url);
admin.pathname = '/postgres';
admin.search = '';

const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
try {
  const { rowCount } = await client.query(
    'SELECT 1 FROM pg_database WHERE datname = $1',
    [name],
  );
  if (rowCount) {
    console.log(`Database "${name}" already exists`);
  } else {
    await client.query(`CREATE DATABASE "${name.replaceAll('"', '""')}"`);
    console.log(`Created database "${name}"`);
  }
} finally {
  await client.end();
}
