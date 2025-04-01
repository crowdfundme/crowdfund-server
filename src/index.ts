// src/index.ts
import express from "express";
import mongoose from "mongoose";
import fundRoutes from "./routes/funds";
import userRoutes from "./routes/users";
import tokenImageRoutes from "./routes/tokenImageRoutes";
import cors from "cors";
import rateLimit from "express-rate-limit";
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

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 100 requests per window
  message: "Too many requests from this IP, please try again later.",
});
app.use(limiter);

// MongoDB connection with retry logic
const connectDB = async () => {
  try {
    await mongoose.connect(config.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s
      maxPoolSize: 10, // Limit connection pool
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    setTimeout(connectDB, 5000); // Retry after 5s
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected, attempting to reconnect...");
  connectDB();
});

connectDB();

// Routes
app.use("/api/funds", fundRoutes);
app.use("/api/users", userRoutes);
app.use("/api/token-images", tokenImageRoutes);

// Start server
app.listen(config.PORT, () => console.log(`Server running on port ${config.PORT} solana network: ${config.SOLANA_NETWORK}`));

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  // Optionally log to a service or take other actions
});

// Graceful shutdown
const gracefulShutdown = async () => {
  console.log("Shutting down server...");
  await mongoose.connection.close();
  console.log("MongoDB connection closed");
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);