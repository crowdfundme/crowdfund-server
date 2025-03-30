// src/index.ts
import express from "express";
import mongoose from "mongoose";
import fundRoutes from "./routes/funds";
import userRoutes from "./routes/users";
import tokenImageRoutes from "./routes/tokenImageRoutes";
import cors from "cors";
import { getConfig } from "./config";
import "./env"; // Ensure env.ts runs first

// Load configuration
const config = getConfig();

// Log the loaded configuration for debugging
console.log("Loaded configuration in index.ts:", {
  CROWD_FUND_CREATION_FEE: config.CROWD_FUND_CREATION_FEE,
  MIN_DONATION: config.MIN_DONATION,
  MAX_DONATION: config.MAX_DONATION,
  WEBSITE_WALLET: config.WEBSITE_WALLET,
  MONGO_URI: config.MONGO_URI,
  PORT: config.PORT,
  SOLANA_NETWORK: config.SOLANA_NETWORK,
  CLOUDINARY_CLOUD_NAME: config.CLOUDINARY_CLOUD_NAME,
  CLOUDINARY_API_KEY: config.CLOUDINARY_API_KEY,
  CLOUDINARY_API_SECRET: config.CLOUDINARY_API_SECRET ? "[hidden]" : undefined,
});

const app = express();

app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"],
}));

app.use(express.json());

// Connect to MongoDB using the config
mongoose.connect(config.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
} as any).then(() => console.log("MongoDB connected")).catch(err => console.error("MongoDB connection error:", err));

// Routes
app.use("/api/funds", fundRoutes);
app.use("/api/users", userRoutes);
app.use("/api/token-images", tokenImageRoutes);

app.listen(config.PORT, () => console.log(`Server running on port ${config.PORT}`));