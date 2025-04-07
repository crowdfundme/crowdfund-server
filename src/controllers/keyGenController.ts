// keyGenController.ts
import { Request, Response } from "express";
import crypto from "crypto";
const { nanoid, customAlphabet } = require("nanoid");
import jwt from "jsonwebtoken";

// Generate a key using crypto.randomBytes
export const generateCryptoKey = (req: Request, res: Response) => {
  try {
    const key = `crowdfund_${crypto.randomBytes(16).toString("hex")}`; // 32 hex chars + prefix
    res.status(200).json({ apiKey: key });
  } catch (error) {
    console.error("Error generating crypto key:", error);
    res.status(500).json({ error: "Failed to generate crypto key" });
  }
};

// Generate a key using crypto.randomUUID
export const generateUuidKey = (req: Request, res: Response) => {
  try {
    const key = `crowdfund_${crypto.randomUUID()}`; // UUID v4 with prefix
    res.status(200).json({ apiKey: key });
  } catch (error) {
    console.error("Error generating UUID key:", error);
    res.status(500).json({ error: "Failed to generate UUID key" });
  }
};

// Generate a key using nanoid
export const generateNanoidKey = (req: Request, res: Response) => {
  try {
    const key = `crowdfund_${nanoid(32)}`; // 32 chars with prefix
    res.status(200).json({ apiKey: key });
  } catch (error) {
    console.error("Error generating nanoid key:", error);
    res.status(500).json({ error: "Failed to generate nanoid key" });
  }
};

// Generate a key using nanoid with a custom alphabet
export const generateNanoidCustomKey = (req: Request, res: Response) => {
  try {
    const generateKey = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_", 32);
    const key = `crowdfund_${generateKey()}`; // 32 chars with prefix and custom alphabet
    res.status(200).json({ apiKey: key });
  } catch (error) {
    console.error("Error generating custom nanoid key:", error);
    res.status(500).json({ error: "Failed to generate custom nanoid key" });
  }
};

// Generate a JWT-based key
export const generateJwtKey = (req: Request, res: Response) => {
  try {
    const payload = {
      iss: "valet-api",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365, // 1 year expiry
    };
    const secret = process.env.JWT_SECRET || "your-jwt-secret"; // Set in .env
    const key = jwt.sign(payload, secret);
    res.status(200).json({ apiKey: key });
  } catch (error) {
    console.error("Error generating JWT key:", error);
    res.status(500).json({ error: "Failed to generate JWT key" });
  }
};