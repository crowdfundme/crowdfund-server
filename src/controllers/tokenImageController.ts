import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";
import Fund from "../models/Fund";
import fs from "fs/promises";
import { asyncHandler } from "../utils/asyncHandler";
import { getConfig } from "../config";

// Import cloudinary and type it as any to bypass TS2307
const cloudinary = require("cloudinary").v2 as any;

// Load configuration
const config = getConfig();

// Configure Cloudinary using config
cloudinary.config({
  cloud_name: config.CLOUDINARY_CLOUD_NAME,
  api_key: config.CLOUDINARY_API_KEY,
  api_secret: config.CLOUDINARY_API_SECRET,
});

// Log Cloudinary config for debugging
console.log("Cloudinary config in tokenImageController:", {
  cloud_name: config.CLOUDINARY_CLOUD_NAME,
  api_key: config.CLOUDINARY_API_KEY,
  api_secret: config.CLOUDINARY_API_SECRET ? "[hidden]" : undefined,
});

// Extend Request type to include Multer's file and specific params
interface MulterRequest extends Request {
  file?: Express.Multer.File;
  params: { fundId: string };
}

// Upload token image
export const uploadTokenImage = asyncHandler(
  async (req: MulterRequest, res: Response, next: NextFunction): Promise<void> => {
    console.log("Starting uploadTokenImage for fundId:", req.params.fundId);

    if (!req.headers["content-type"]?.startsWith("multipart/form-data")) {
      console.log("Invalid content-type:", req.headers["content-type"]);
      res.status(400).json({ error: "Expected multipart/form-data" });
      return;
    }

    const fundId = req.params.fundId;
    if (!mongoose.Types.ObjectId.isValid(fundId)) {
      console.log("Invalid fundId:", fundId);
      res.status(400).json({ error: "Invalid fund ID" });
      return;
    }

    const fund = await Fund.findById(fundId);
    if (!fund) {
      console.log("Fund not found for fundId:", fundId);
      res.status(404).json({ error: "Fund not found" });
      return;
    }

    if (!req.file) {
      console.log("No file provided for fundId:", fundId);
      res.status(400).json({ error: "No image file provided" });
      return;
    }

    try {
      // Verify file exists and is readable
      await fs.access(req.file.path, fs.constants.R_OK);
      const fileStats = await fs.stat(req.file.path);
      const fileBuffer = await fs.readFile(req.file.path, { encoding: null });
      const fileMagic = fileBuffer.toString("hex", 0, 4); // First 4 bytes for MIME check
      console.log("File verified:", {
        path: req.file.path,
        size: fileStats.size,
        mimeType: req.file.mimetype,
        magicNumber: fileMagic,
      });

      // Delete existing token image if it exists
      if (fund.image) {
        await cloudinary.uploader.destroy(fund.image);
        console.log(`Deleted old token image with ID: ${fund.image}`);
      }

      // Upload new image to Cloudinary
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: "crowdfund_token_images",
        public_id: `token_${fundId}_${Date.now()}`,
        overwrite: true,
      });
      console.log("Cloudinary upload successful:", { public_id: result.public_id, url: result.secure_url });

      // Update fund with new image ID
      fund.image = result.public_id;
      await fund.save();
      console.log("Fund updated with new image ID:", fundId);

      // Delete temporary file
      await fs.unlink(req.file.path);
      console.log(`Deleted temporary file: ${req.file.path}`);

      // Send response
      const responseData = {
        message: "Token image uploaded successfully",
        tokenImageId: result.public_id,
        url: result.secure_url,
      };
      console.log("Sending response:", responseData);
      res.setHeader("Content-Type", "application/json");
      res.status(200).json(responseData);
    } catch (error: any) {
      console.error("Error in uploadTokenImage:", error);
      if (req.file) {
        try {
          await fs.unlink(req.file.path);
          console.log(`Deleted temporary file after error: ${req.file.path}`);
        } catch (deleteError) {
          console.error("Error deleting temporary file after failure:", deleteError);
        }
      }
      if (error.http_code === 400) {
        res.status(400).json({ error: "Invalid image file", details: error.message });
      } else {
        res.status(500).json({ error: "Failed to upload image to Cloudinary", details: error.message });
      }
    }
    console.log("Finished uploadTokenImage for fundId:", fundId);
  }
);

// Get token image
export const getTokenImage = asyncHandler(
  async (req: Request<{ fundId: string }>, res: Response, next: NextFunction): Promise<void> => {
    const fundId = req.params.fundId;
    if (!mongoose.Types.ObjectId.isValid(fundId)) {
      res.status(400).json({ error: "Invalid fund ID" });
      return;
    }

    const fund = await Fund.findById(fundId);
    if (!fund) {
      res.status(404).json({ error: "Fund not found" });
      return;
    }

    if (!fund.image) {
      res.status(404).json({ error: "No token image found for this fund" });
      return;
    }

    const imageUrl = cloudinary.url(fund.image, {
      secure: true,
      transformation: [{ width: 200, height: 200, crop: "fill" }],
    });

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ tokenImageId: fund.image, url: imageUrl });
  }
);

// Delete token image
export const deleteTokenImage = asyncHandler(
  async (req: Request<{ fundId: string }>, res: Response, next: NextFunction): Promise<void> => {
    const fundId = req.params.fundId;
    if (!mongoose.Types.ObjectId.isValid(fundId)) {
      res.status(400).json({ error: "Invalid fund ID" });
      return;
    }

    const fund = await Fund.findById(fundId);
    if (!fund) {
      res.status(404).json({ error: "Fund not found" });
      return;
    }

    if (!fund.image) {
      res.status(404).json({ error: "No token image to delete" });
      return;
    }

    await cloudinary.uploader.destroy(fund.image);

    fund.image = undefined;
    await fund.save();

    res.setHeader("Content-Type", "application/json");
    res.status(200).json({ message: "Token image deleted successfully" });
  }
);