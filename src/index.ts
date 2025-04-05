import express from "express";
import mongoose from "mongoose";
import fundRoutes from "./routes/funds";
import userRoutes from "./routes/users";
import tokenImageRoutes from "./routes/tokenImageRoutes";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { getConfig } from "./config";
import "./env";

const config = getConfig();

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
  SOLANA_RPC_ENDPOINT: config.SOLANA_RPC_ENDPOINT,
});

const app = express();

// CORS setup
app.use(cors({
  origin: "http://localhost:3000",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"],
}));

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per window
  message: "Too many requests from this IP, please try again later.",
});
app.use(limiter);

// Routes with JSON parsing
app.use("/api/funds", express.json({ limit: "10mb" }), fundRoutes);
app.use("/api/users", express.json({ limit: "10mb" }), userRoutes);

// Route with Multer (no JSON parsing)
app.use("/api/token-images", tokenImageRoutes);

// Optional: Middleware for parsing large URL-encoded payloads (if needed elsewhere)
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Custom error middleware to ensure JSON responses
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error middleware caught:", err);
  if (res.headersSent) {
    return next(err); // Pass to default handler if headers already sent
  }
  res.setHeader("Content-Type", "application/json");
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// MongoDB connection with retry logic
const connectDB = async () => {
  try {
    await mongoose.connect(config.MONGO_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 10,
    });
    console.log("MongoDB connected");
  } catch (err) {
    console.error("MongoDB connection error:", err);
    setTimeout(connectDB, 5000);
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected, attempting to reconnect...");
  connectDB();
});

connectDB();

// Start server
app.listen(config.PORT, () =>
  console.log(`Server running on port ${config.PORT} solana network: ${config.SOLANA_NETWORK} SOLANA_RPC_ENDPOINT: ${config.SOLANA_RPC_ENDPOINT}`)
);

// Handle unhandled promise rejections
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
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