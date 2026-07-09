import { pingDb } from '../mongo.js';

try {
  const result = await pingDb();
  console.log(`MongoDB connected: ${result.dbName}`);
  process.exit(0);
} catch (error) {
  console.error(`MongoDB connection failed: ${error.message}`);
  process.exit(1);
}
