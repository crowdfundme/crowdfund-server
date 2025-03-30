// src/routes/tokenImageRoutes.ts
import { Router } from "express";
import * as tokenImageController from "../controllers/tokenImageController";
import multer from "multer";

const upload = multer({ dest: "uploads/" });
const router = Router();

router.post(
  "/:fundId/token-image",
  upload.single("image"),
  tokenImageController.uploadTokenImage
);

router.get("/:fundId/token-image", tokenImageController.getTokenImage);

router.delete("/:fundId/token-image", tokenImageController.deleteTokenImage);

export default router;