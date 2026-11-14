import mongoose from "mongoose";

mongoose.set("bufferCommands", false);

interface MongooseCache {
  conn: typeof mongoose | null;
  promise: Promise<typeof mongoose | null> | null;
}

declare global {
  // eslint-disable-next-line no-var
  var mongooseCache: MongooseCache | undefined;
}

const cached: MongooseCache =
  global.mongooseCache ?? (global.mongooseCache = { conn: null, promise: null });

let warnedOffline = false;

export function isDbConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

export async function connectDB(): Promise<typeof mongoose | null> {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    if (!warnedOffline) {
      warnedOffline = true;
      console.warn(
        "[db] MONGODB_URI is not set — running in offline fallback mode"
      );
    }
    return null;
  }

  if (cached.conn && isDbConnected()) {
    return cached.conn;
  }

  if (!cached.promise) {
    cached.promise = mongoose
      .connect(uri, {
        bufferCommands: false,
        serverSelectionTimeoutMS: 3000,
      })
      .then((m) => m)
      .catch((err: unknown) => {
        cached.promise = null;
        if (!warnedOffline) {
          warnedOffline = true;
          const msg = err instanceof Error ? err.message : String(err);
          console.warn("[db] MongoDB connection failed — offline fallback active:", msg);
        }
        return null;
      });
  }

  cached.conn = await cached.promise;
  return cached.conn;
}
