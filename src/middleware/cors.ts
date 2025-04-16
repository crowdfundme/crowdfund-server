// cors.ts
import express from "express";
import cors from "cors";
import { getConfig } from "../config";

// Load configuration
const config = getConfig();

const allowedIps = new Set<string>([
  // Add trusted IPs here, e.g., your Vercel IP ranges or local dev IPs
  "127.0.0.1", // Localhost for dev
  // Example: "192.168.1.1",
]);

console.log("CORS FRONTEND_URL:", config.FRONTEND_URL);

const corsOptions: cors.CorsOptions = {
  origin: (origin, callback) => {
    const allowedOrigins = [
        config.FRONTEND_URL,
      "http://localhost:3001",      
      "http://localhost:3000",
    ].filter(Boolean); // Filter out undefined values

    console.log("CORS Origin:", origin, "Allowed:", allowedOrigins);

    // Allow requests with no origin (e.g., server-to-server) or matching origins
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error("Not allowed by CORS"));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept", "X-API-Key","X-From-Vercel"], // Add custom header for API key
  credentials: true,
};

// Middleware to check IP whitelist (optional layer)
const ipWhitelistMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const clientIp = req.ip || req.socket.remoteAddress;
  if (clientIp && allowedIps.has(clientIp)) {
    next();
  } else if (!clientIp) {
    console.warn("No client IP detected");
    next(); // Optionally allow if IP detection fails
  } else {
    console.log(`IP ${clientIp} rejected by whitelist`);
    res.status(403).json({ error: "Forbidden: IP not whitelisted" });
  }
};

export default cors(corsOptions);
export { ipWhitelistMiddleware };