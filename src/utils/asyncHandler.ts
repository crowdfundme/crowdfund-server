// src/utils/asyncHandler.ts
import { Request, Response, NextFunction } from "express";

// Make asyncHandler generic with a type parameter for the Request type
export const asyncHandler = <T extends Request>(
  fn: (req: T, res: Response, next: NextFunction) => Promise<any>
) => {
  return (req: T, res: Response, next: NextFunction) => {
    fn(req, res, next).catch(next);
  };
};