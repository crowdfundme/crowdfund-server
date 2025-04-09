import express from "express";
import mongoose from "mongoose";
import fundRoutes from "./routes/funds";
import userRoutes from "./routes/users";
import utilityRoutes from "./routes/utilityRoutes";
import tokenImageRoutes from "./routes/tokenImageRoutes";
import cors from "cors";
import corsMiddleware from "./middleware/cors";
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
  FRONTEND_URL: config.FRONTEND_URL,
  API_KEY: config.API_KEY,
});

const app = express();
const API_KEY = config.API_KEY || "your-secure-api-key-here";

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // Limit each IP to 1000 requests per window
  message: "Too many requests from this IP, please try again later.",
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => req.headers["X-From-Vercel"] === "true",
});

const apiKeyMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const apiKey = req.headers["x-api-key"];
  if (apiKey === API_KEY) {
    next();
  } else {
    res.status(401).json({ error: "Unauthorized: Invalid or missing API key" });
  }
};

app.use(limiter);
app.use(corsMiddleware);
app.use(apiKeyMiddleware);

// Routes with JSON parsing
app.use("/api/funds", express.json({ limit: "10mb" }), fundRoutes);
app.use("/api/users", express.json({ limit: "10mb" }), userRoutes);
app.use("/api/utility", express.json({ limit: "10mb" }), utilityRoutes);

// Route with Multer (no JSON parsing)
app.use("/api/token-images", tokenImageRoutes);

// Optional: Middleware for parsing large URL-encoded payloads
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

app.get("/api/test", (req, res) => {
  res.send(`CrowdFund.Fun Server is live! Endpoint: ${config.SOLANA_RPC_ENDPOINT}`);
});

app.get("/api/status", (req, res) => {
  const isLive = true; // Add any additional health checks here if needed
  res.status(200).json({ isLive });
});

// Custom error middleware to ensure JSON responses
app.use((err: any, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error("Error middleware caught:", err);
  if (res.headersSent) {
    return next(err);
  }
  res.setHeader("Content-Type", "application/json");
  res.status(err.status || 500).json({
    error: err.message || "Internal server error",
    details: process.env.NODE_ENV === "development" ? err.stack : undefined,
  });
});

// MongoDB connection with limited retries
const MAX_RETRIES = 5;
let retryCount = 0;
let isConnecting = false; // Prevent multiple concurrent connection attempts

const connectDB = async () => {
  if (isConnecting) {
    console.log("Connection attempt already in progress, skipping...");
    return;
  }

  isConnecting = true;
  try {
    await mongoose.connect(config.MONGO_URI, {
      serverSelectionTimeoutMS: 5000, // Timeout after 5s if no server found
      connectTimeoutMS: 10000, // Timeout connection attempt after 10s
      maxPoolSize: 10, // Limit connection pool
      retryWrites: true,
      w: "majority",
      // Explicitly disable Mongoose's built-in reconnection
      bufferCommands: false, // Disable command buffering during disconnects
    });
    console.log("MongoDB connected successfully");
    retryCount = 0; // Reset on success
  } catch (err) {
    console.error("MongoDB connection error:", err);
    if (retryCount < MAX_RETRIES) {
      retryCount++;
      console.log(`Retrying connection (${retryCount}/${MAX_RETRIES}) in 5 seconds...`);
      setTimeout(() => {
        isConnecting = false; // Allow next attempt
        connectDB();
      }, 5000);
    } else {
      console.error("Max retries reached. Shutting down server.");
      process.exit(1);
    }
  } finally {
    isConnecting = false; // Reset flag after attempt
  }
};

// Log connection events for debugging
mongoose.connection.on("connected", () => {
  console.log("Mongoose connection established");
});

mongoose.connection.on("disconnected", () => {
  console.warn("MongoDB disconnected");
  // Only log, don’t automatically retry here to avoid loop
});

mongoose.connection.on("error", (err) => {
  console.error("MongoDB connection error event:", err);
});

// Initial connection attempt
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