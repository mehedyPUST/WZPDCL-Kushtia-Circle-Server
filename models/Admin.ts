import mongoose from "mongoose";
import bcrypt from "bcryptjs";

const adminSchema = new mongoose.Schema(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    password: {
      type: String,
      required: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      default: undefined,
    },
    displayName: {
      type: String,
      trim: true,
      default: "",
    },
    role: {
      type: String,
      enum: [
        "viewer",
        "duty",
        "admin",
        "circle-load-input",
        "operator",
        "superadmin",
        "duty-person",
      ],
      default: "viewer",
    },
    lastLogin: {
      type: Date,
      default: null,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    assignedStation: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

adminSchema.index(
  { email: 1 },
  { unique: true, sparse: true, name: "email_1_sparse" }
);

adminSchema.pre("save", async function () {
  // Sparse unique index breaks if null or empty string is stored
  if (this.email == null || String(this.email).trim() === "") {
    this.email = undefined;
    this.set("email", undefined);
  }

  if (!this.isModified("password")) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

adminSchema.methods.comparePassword = async function (
  candidatePassword: string
): Promise<boolean> {
  return bcrypt.compare(candidatePassword, this.password);
};

const Admin: mongoose.Model<any> =
  mongoose.models.Admin || mongoose.model("Admin", adminSchema);
export default Admin;
