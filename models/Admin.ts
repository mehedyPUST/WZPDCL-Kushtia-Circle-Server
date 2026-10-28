const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

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
    /**
     * viewer — view only (home, calculator, history, max load, statistics)
     * duty — full operational pages except admin; can save
     * admin — settings, users, see who saved data
     */
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
    /**
     * Circle-load station this user may edit (manual SS).
     * empty / null = none (unless admin).
     * bottail is filled from Calculator — still can assign for visibility.
     */
    assignedStation: {
      type: String,
      default: "",
    },
  },
  { timestamps: true }
);

// Sparse unique: multiple docs may omit email; only non-null emails must be unique
adminSchema.index(
  { email: 1 },
  { unique: true, sparse: true, name: "email_1_sparse" }
);

adminSchema.pre("save", async function (next) {
  // Never persist empty string / null email (breaks unique index on null)
  if (this.email == null || String(this.email).trim() === "") {
    this.email = undefined;
    this.set("email", undefined);
  }

  if (!this.isModified("password")) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

adminSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

module.exports = mongoose.models.Admin || mongoose.model("Admin", adminSchema);
