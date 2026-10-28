/**
 * One-time fix for:
 * E11000 duplicate key error ... index: email_1 dup key: { email: null }
 *
 * Run from server folder:
 *   node fix-email-index.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI missing in .env");
    process.exit(1);
  }
  await mongoose.connect(uri);
  const col = mongoose.connection.collection("admins");

  // Unset empty / null emails so sparse unique works
  const unset = await col.updateMany(
    { $or: [{ email: null }, { email: "" }] },
    { $unset: { email: "" } }
  );
  console.log("Unset empty emails:", unset.modifiedCount);

  // Drop non-sparse unique index if present
  try {
    await col.dropIndex("email_1");
    console.log("Dropped index email_1");
  } catch (e) {
    console.log("drop email_1:", e.message);
  }
  try {
    await col.dropIndex("email_1_sparse");
    console.log("Dropped index email_1_sparse");
  } catch (e) {
    console.log("drop email_1_sparse:", e.message || e);
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
