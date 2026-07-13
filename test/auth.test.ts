import assert from "node:assert/strict";
import test from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { JwtAccessTokenVerifier, protectedResourceMetadata, resolveOAuthConfig } from "../src/auth.js";

test("OAuth configuration resolves Auth0-compatible defaults", () => {
  const config = resolveOAuthConfig({
    VERONICA_OAUTH_ISSUER: "https://tenant.example.com/",
    VERONICA_OAUTH_AUDIENCE: "https://veronica.example.com/",
    VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
  });

  assert.equal(config.jwksUri.href, "https://tenant.example.com/.well-known/jwks.json");
  assert.deepEqual(protectedResourceMetadata(config), {
    resource: "https://veronica.example.com/",
    authorization_servers: ["https://tenant.example.com/"],
    bearer_methods_supported: ["header"],
    scopes_supported: ["veronica:read", "veronica:write"]
  });
});

test("JWT verifier validates signature, issuer, audience, expiry, and permissions", async () => {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const publicJwk = await exportJWK(publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";
  const config = resolveOAuthConfig({
    VERONICA_OAUTH_ISSUER: "https://tenant.example.com/",
    VERONICA_OAUTH_AUDIENCE: "https://veronica.example.com/",
    VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
  });
  const verifier = new JwtAccessTokenVerifier(config, createLocalJWKSet({ keys: [publicJwk] }));
  const token = await new SignJWT({ permissions: ["veronica:read", "veronica:write"] })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(config.issuer.href)
    .setAudience(config.audience)
    .setSubject("user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);

  const auth = await verifier.verifyAccessToken(token);
  assert.equal(auth.clientId, "user-123");
  assert.deepEqual(auth.scopes, ["veronica:read", "veronica:write"]);
  assert.equal(auth.resource?.href, "https://veronica.example.com/");

  const wrongAudience = await new SignJWT({ scope: "veronica:read veronica:write" })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer(config.issuer.href)
    .setAudience("https://other.example.com/")
    .setSubject("user-123")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  await assert.rejects(() => verifier.verifyAccessToken(wrongAudience), /Access token is invalid/);
});

test("OAuth configuration rejects insecure URLs", () => {
  assert.throws(
    () =>
      resolveOAuthConfig({
        VERONICA_OAUTH_ISSUER: "http://tenant.example.com/",
        VERONICA_OAUTH_AUDIENCE: "https://veronica.example.com/",
        VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
      }),
    /must use HTTPS/
  );
});

test("OAuth audience must exactly identify the protected resource", () => {
  assert.throws(
    () =>
      resolveOAuthConfig({
        VERONICA_OAUTH_ISSUER: "https://tenant.example.com/",
        VERONICA_OAUTH_AUDIENCE: "https://other.example.com/",
        VERONICA_OAUTH_RESOURCE: "https://veronica.example.com/"
      }),
    /must exactly match/
  );
});
