import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'kritech_solution';

if (!uri) {
  throw new Error('Missing MONGODB_URI. Add it to .env or your Railway environment variables.');
}

const client = new MongoClient(uri, {
  serverSelectionTimeoutMS: 10000
});
let connectionPromise;

export async function getDb() {
  if (!connectionPromise) {
    connectionPromise = client.connect();
  }

  const connectedClient = await connectionPromise;
  return connectedClient.db(dbName);
}

export async function pingDb() {
  const db = await getDb();
  await db.command({ ping: 1 });
  return {
    ok: true,
    dbName
  };
}
