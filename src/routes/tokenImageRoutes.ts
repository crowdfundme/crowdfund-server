import { Router, Request, Response, NextFunction } from "express";
import * as tokenImageController from "../controllers/tokenImageController";
import multer from "multer";
import { getConfig } from "../config";

const config = getConfig();
const upload = multer({
  dest: "uploads/",
  limits: { fileSize: config.MAX_IMAGE_SIZE_MB * 1024 * 1024 }, // Dynamic limit in bytes
});

const router = Router();

router.post(
  "/:fundId/token-image",
  (req: Request, res: Response, next: NextFunction) => {
    console.log("Received POST to /api/token-images/:fundId/token-image with headers:", req.headers);
    next();
  },
  upload.single("image"),
  tokenImageController.uploadTokenImage
);

router.get("/:fundId/token-image", tokenImageController.getTokenImage);

router.delete("/:fundId/token-image", tokenImageController.deleteTokenImage);

export default router;