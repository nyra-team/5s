import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.SESSION_SECRET || "dev-secret-change-me";

export interface JwtPayload {
  userId: number;
  role: string;
}

/**
 * Default JWT lifetime is 24 hours so a forgotten tab on a shared
 * machine doesn't grant indefinite access. When the operator ticks
 * "Remember me" at sign-in we extend to 30 days — same security model
 * (signed with the same secret, no refresh-token rotation), just a
 * longer expiry baked into the claim. Anything more elaborate (real
 * refresh tokens, session revocation) is tracked under Item 5b's
 * follow-up.
 */
export function signToken(payload: JwtPayload, options?: { rememberMe?: boolean }): string {
  const expiresIn = options?.rememberMe ? "30d" : "24h";
  return jwt.sign(payload, JWT_SECRET, { expiresIn });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const payload = verifyToken(header.slice(7));
    (req as any).user = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

/**
 * Gate a route to a specific role. ADMIN is a global superuser: it satisfies
 * every `requireRole(...)` check, so admins can reach manager- and
 * operator-scoped routes without us having to enumerate "MANAGER or ADMIN" at
 * every call site. MANAGER and OPERATOR keep their exact-match semantics —
 * adding the ADMIN tier on top doesn't widen what they can do.
 */
export function requireRole(role: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = (req as any).user as JwtPayload | undefined;
    if (!user || (user.role !== role && user.role !== "ADMIN")) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  };
}

/** Convenience guard for routes only an ADMIN may touch (user management). */
export const requireAdmin = requireRole("ADMIN");
