import 'dotenv/config';
import { MongoClient } from 'mongodb';

const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME || 'kritech_solution';

const client = uri
  ? new MongoClient(uri, {
      serverSelectionTimeoutMS: 10000
    })
  : null;
let connectionPromise;

export async function getDb() {
  if (!client) {
    throw new Error('Missing MONGODB_URI. Add it to .env or your Railway environment variables.');
  }

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
