/**
 * One-time fix for:
 * E11000 duplicate key error ... index: email_1 dup key: { email: null }
 */
import "dotenv/config";
import mongoose from "mongoose";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI missing in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection("admins");

  const unset = await col.updateMany(
    { $or: [{ email: null }, { email: "" }] },
    { $unset: { email: "" } }
  );
  console.log("Unset empty emails:", unset.modifiedCount);

  for (const indexName of ["email_1", "email_1_sparse"]) {
    try {
      await col.dropIndex(indexName);
      console.log(`Dropped index ${indexName}`);
    } catch (e) {
      console.log(
        `drop ${indexName}:`,
        e instanceof Error ? e.message : String(e)
      );
    }
  }

  await col.createIndex(
    { email: 1 },
    { unique: true, sparse: true, name: "email_1_sparse" }
  );
  console.log("Created sparse unique index email_1_sparse");

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
