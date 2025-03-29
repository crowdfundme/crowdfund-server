import mongoose, { Schema } from "mongoose";

const UserSchema = new Schema({
  walletAddress: { type: String, required: true, unique: true },
  name: { type: String },
  email: { type: String },
});

export default mongoose.models.User || mongoose.model("User", UserSchema);