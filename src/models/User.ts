import mongoose, { Schema } from "mongoose";

const DonationSchema = new Schema({
  fundId: { type: Schema.Types.ObjectId, ref: "Fund", required: true },
  amount: { type: Number, required: true },
  donatedAt: { type: Date, default: Date.now },
});

const UserSchema = new Schema({
  walletAddress: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String },
  donations: [DonationSchema], // Tracks donations per fund
  totalDonatedSol: { type: Number, default: 0 }, // Total SOL donated across all funds
});

export default mongoose.models.User || mongoose.model("User", UserSchema);