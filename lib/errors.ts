import mongoose from "mongoose";

export function clientError(err: unknown): string | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return err instanceof Error ? err.message : String(err);
}

export function isValidObjectId(id: unknown): boolean {
  return typeof id === "string" && mongoose.isValidObjectId(id);
}

export function isDuplicateKeyError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: number }).code === 11000
  );
}
