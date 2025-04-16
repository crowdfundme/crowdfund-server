// utilityRoutes.ts
import { Router, RequestHandler, Request, Response } from "express";
import * as keyGenController from "../controllers/keyGenController";

const router = Router();

// Type-safe handler assertions
router.get("/generate/crypto", keyGenController.generateCryptoKey as RequestHandler);
router.get("/generate/uuid", keyGenController.generateUuidKey as RequestHandler);
router.get("/generate/nanoid", keyGenController.generateNanoidKey as RequestHandler);
router.get("/generate/nanoid-custom", keyGenController.generateNanoidCustomKey as RequestHandler);
router.get("/generate/jwt", keyGenController.generateJwtKey as RequestHandler);

export default router;