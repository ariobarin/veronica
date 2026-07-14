import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";

export function requireDeviceToken(token: string) {
  const expected = Buffer.from(`Bearer ${token}`);
  return (req: Request, res: Response, next: NextFunction) => {
    const actual = Buffer.from(req.headers.authorization ?? "");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}
