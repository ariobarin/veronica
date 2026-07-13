import type { NextFunction, Request, Response } from "express";
import { timingSafeEqual } from "node:crypto";
import { InvalidTokenError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

export const VERONICA_OAUTH_SCOPES = ["veronica:access"] as const;

export interface VeronicaOAuthConfig {
  issuer: URL;
  audience: string;
  resource: URL;
  jwksUri: URL;
  scopes: string[];
}

function requiredValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} must be set`);
  return value;
}

function httpsUrl(name: string, value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${name} must use HTTPS`);
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a fragment`);
  }
  return url;
}

export function resolveOAuthConfig(environment: NodeJS.ProcessEnv = process.env): VeronicaOAuthConfig {
  const issuer = httpsUrl("VERONICA_OAUTH_ISSUER", requiredValue(environment, "VERONICA_OAUTH_ISSUER"));
  const resource = httpsUrl("VERONICA_OAUTH_RESOURCE", requiredValue(environment, "VERONICA_OAUTH_RESOURCE"));
  const configuredJwksUri = environment.VERONICA_OAUTH_JWKS_URI?.trim();
  const jwksUri = configuredJwksUri
    ? httpsUrl("VERONICA_OAUTH_JWKS_URI", configuredJwksUri)
    : new URL(".well-known/jwks.json", issuer.href.endsWith("/") ? issuer : new URL(`${issuer.href}/`));
  return {
    issuer,
    audience: resource.href,
    resource,
    jwksUri,
    scopes: [...VERONICA_OAUTH_SCOPES]
  };
}

function claimString(payload: JWTPayload, name: string): string | undefined {
  const value = payload[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function tokenScopes(payload: JWTPayload): string[] {
  const scope = claimString(payload, "scope")?.split(/\s+/).filter(Boolean) ?? [];
  const permissions = Array.isArray(payload.permissions)
    ? payload.permissions.filter((permission): permission is string => typeof permission === "string")
    : [];
  return [...new Set([...scope, ...permissions])];
}

export class JwtAccessTokenVerifier implements OAuthTokenVerifier {
  readonly #config: VeronicaOAuthConfig;
  readonly #getKey: JWTVerifyGetKey;

  constructor(config: VeronicaOAuthConfig, getKey: JWTVerifyGetKey = createRemoteJWKSet(config.jwksUri)) {
    this.#config = config;
    this.#getKey = getKey;
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    try {
      const { payload } = await jwtVerify(token, this.#getKey, {
        issuer: this.#config.issuer.href,
        audience: this.#config.audience,
        algorithms: ["RS256"],
        requiredClaims: ["exp"]
      });
      const clientId = claimString(payload, "client_id") ?? claimString(payload, "azp") ?? payload.sub;
      if (!clientId) throw new Error("Access token has no client identifier");

      return {
        token,
        clientId,
        scopes: tokenScopes(payload),
        expiresAt: payload.exp,
        resource: this.#config.resource,
        extra: { subject: payload.sub }
      };
    } catch {
      throw new InvalidTokenError("Access token is invalid");
    }
  }
}

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

export function protectedResourceMetadata(config: VeronicaOAuthConfig) {
  return {
    resource: config.resource.href,
    authorization_servers: [config.issuer.href],
    bearer_methods_supported: ["header"],
    scopes_supported: config.scopes
  };
}

export function resourceMetadataUrl(config: VeronicaOAuthConfig): string {
  return new URL("/.well-known/oauth-protected-resource", config.resource).href;
}
