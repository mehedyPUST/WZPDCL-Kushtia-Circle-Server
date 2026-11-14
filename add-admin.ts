import "dotenv/config";
import mongoose from "mongoose";
import readline from "readline";
import Admin from "./models/Admin.js";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

const MONGODB_URI = process.env.MONGODB_URI;

function prompt(question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      resolve(answer);
    });
  });
}

async function addAdmin() {
  try {
    console.log("\n========================================");
    console.log("  WZPDCL Admin User Creator");
    console.log("========================================\n");

    const username = (await prompt("Enter username: ")).trim();
    if (!username) {
      console.log("❌ Username is required");
      process.exit(1);
    }

    const password = await prompt("Enter password: ");
    if (!password || password.length < 8) {
      console.log("❌ Password must be at least 8 characters");
      process.exit(1);
    }

    const email = (await prompt("Enter email: ")).trim().toLowerCase();
    if (!email || !email.includes("@")) {
      console.log("❌ Valid email is required");
      process.exit(1);
    }

    const roleInput = (
      await prompt("Enter role (admin/superadmin) [default: admin]: ")
    ).trim();
    const role = roleInput === "superadmin" ? "superadmin" : "admin";

    console.log("\n📝 Creating admin with:");
    console.log(`   Username: ${username}`);
    console.log(`   Email: ${email}`);
    console.log(`   Role: ${role}\n`);

    const confirm = await prompt("Continue? (y/N): ");
    if (confirm.toLowerCase() !== "y") {
      console.log("❌ Admin creation cancelled.");
      process.exit(0);
    }

    if (!MONGODB_URI) {
      console.error("❌ MONGODB_URI is not set in environment");
      process.exit(1);
    }

    console.log("\n🔄 Connecting to MongoDB...");
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      socketTimeoutMS: 45000,
    });
    console.log("✅ Connected to MongoDB");

    console.log("🔍 Checking for existing admins...");
    const existing = await Admin.findOne({
      $or: [{ username }, { email }],
    });

    if (existing) {
      console.log("⚠️  Admin already exists:");
      console.log(`   Username: ${existing.username}`);
      console.log(`   Email: ${existing.email}`);
      console.log(`   Role: ${existing.role}`);
      console.log(`   Active: ${existing.isActive}`);
      process.exit(0);
    }

    console.log("📝 Creating admin user...");
    await Admin.create({
      username,
      password,
      email,
      role,
      isActive: true,
    });

    console.log("\n✅ Admin created successfully!");
    console.log("========================================");
    console.log("🔑 Login Credentials:");
    console.log(`   Username: ${username}`);
    console.log(`   Email: ${email}`);
    console.log(`   Role: ${role}`);
    console.log("   Password: [hidden]");
    console.log("========================================\n");

    process.exit(0);
  } catch (error) {
    console.error(
      "\n❌ Error:",
      error instanceof Error ? error.message : error
    );
    process.exit(1);
  } finally {
    rl.close();
  }
}

void addAdmin();