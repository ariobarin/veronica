import express, { type Request, type Response } from "express";
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import type { OAuthTokenVerifier } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import { z } from "zod/v4";
import {
  JwtAccessTokenVerifier,
  protectedResourceMetadata,
  requireDeviceToken,
  resolveOAuthConfig,
  resourceMetadataUrl,
  type VeronicaOAuthConfig
} from "./auth.js";
import { Broker } from "./broker.js";
import {
  commandSchema,
  commandValueSchema,
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  pollDeviceSchema,
  readFileValueSchema,
  registerDeviceSchema,
  relativePathSchema,
  sha256Schema,
  submitResultSchema,
  textContentSchema,
  timeoutSecondsSchema,
  toWorkerError,
  VeronicaError,
  workerErrorSchema,
  writeFileValueSchema
} from "./protocol.js";

const oauthSecuritySchemes = [{ type: "oauth2", scopes: ["veronica:read", "veronica:write"] }] as const;
const oauthToolMeta = { securitySchemes: oauthSecuritySchemes };

function jsonResult(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function errorResult(error: unknown) {
  const parsed = workerErrorSchema.safeParse(error);
  const detail = parsed.success ? parsed.data : toWorkerError(error);
  return {
    isError: true,
    structuredContent: detail,
    content: [{ type: "text" as const, text: detail.message }]
  };
}

export function createVeronicaMcpServer(broker: Broker): McpServer {
  const server = new McpServer(
    { name: "veronica", version: "0.0.0" },
    {
      instructions: [
        "Veronica routes a small set of coding operations to explicitly exposed local workspaces.",
        "Call list_devices, then open_workspace, then use the returned workspace_id."
      ].join(" ")
    }
  );

  server.registerTool(
    "list_devices",
    {
      title: "List Veronica devices",
      description: "List computers currently known to the Veronica gateway.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: oauthToolMeta
    },
    async () => jsonResult({ devices: broker.listDevices() })
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open Veronica workspace",
      description: "Open a directory below a named device's exposed root.",
      inputSchema: {
        device: z.string().min(1),
        path: relativePathSchema.default(".")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: oauthToolMeta
    },
    async ({ device, path: workspacePath }) => {
      try {
        const workspace = await broker.openWorkspace(device, workspacePath);
        return jsonResult({
          workspace_id: workspace.id,
          device_id: workspace.deviceId,
          path: workspace.path
        });
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "read_file",
    {
      title: "Read workspace file",
      description: "Read a UTF-8 text file and its SHA-256 revision inside an open Veronica workspace.",
      inputSchema: {
        workspace_id: z.string().uuid(),
        path: relativePathSchema
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: oauthToolMeta
    },
    async ({ workspace_id: workspaceId, path: filePath }) => {
      try {
        const result = await broker.executeInWorkspace(workspaceId, workspace => ({
          type: "read_file",
          workspace,
          path: filePath
        }));
        if (!result.ok) return errorResult(result.error);
        return jsonResult(readFileValueSchema.parse(result.value));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write workspace file",
      description: "Atomically replace a UTF-8 text file, optionally only at an expected SHA-256 revision.",
      inputSchema: {
        workspace_id: z.string().uuid(),
        path: relativePathSchema,
        content: textContentSchema,
        expected_sha256: sha256Schema.optional()
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false
      },
      _meta: oauthToolMeta
    },
    async ({ workspace_id: workspaceId, path: filePath, content, expected_sha256: expectedSha256 }) => {
      try {
        const result = await broker.executeInWorkspace(workspaceId, workspace => ({
          type: "write_file",
          workspace,
          path: filePath,
          content,
          expectedSha256
        }));
        if (!result.ok) return errorResult(result.error);
        return jsonResult(writeFileValueSchema.parse(result.value));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "run_command",
    {
      title: "Run workspace command",
      description: "Run one shell command in an open Veronica workspace and return its completed output.",
      inputSchema: {
        workspace_id: z.string().uuid(),
        command: commandSchema,
        timeout_seconds: timeoutSecondsSchema.default(DEFAULT_COMMAND_TIMEOUT_SECONDS)
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true
      },
      _meta: oauthToolMeta
    },
    async ({ workspace_id: workspaceId, command, timeout_seconds: timeoutSeconds }) => {
      try {
        const result = await broker.executeInWorkspace(
          workspaceId,
          workspace => ({
            type: "run_command",
            workspace,
            command,
            timeoutSeconds
          }),
          (timeoutSeconds + 10) * 1000
        );
        if (!result.ok) return errorResult(result.error);
        return jsonResult(commandValueSchema.parse(result.value));
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "close_workspace",
    {
      title: "Close Veronica workspace",
      description: "Forget an open workspace lease.",
      inputSchema: { workspace_id: z.string().uuid() },
      annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: false },
      _meta: oauthToolMeta
    },
    async ({ workspace_id: workspaceId }) => jsonResult({ closed: broker.closeWorkspace(workspaceId) })
  );

  return server;
}

function statusForError(error: unknown): number {
  if (!(error instanceof VeronicaError)) return 400;
  if (error.code === "not_found") return 404;
  if (error.code === "conflict") return 409;
  if (error.code === "unavailable") return 503;
  if (error.code === "timeout") return 504;
  return 400;
}

export function resolveAllowedHosts(): string[] | undefined {
  const configured = process.env.VERONICA_ALLOWED_HOSTS;
  if (configured === undefined) return undefined;
  const hosts = [...new Set(configured.split(",").map(host => host.trim()).filter(Boolean))];
  if (hosts.length === 0) throw new Error("VERONICA_ALLOWED_HOSTS must contain at least one hostname");
  return hosts;
}

export function resolveListenHosts(): string[] {
  const configured = process.env.HOSTS ?? process.env.HOST ?? "127.0.0.1";
  const hosts = [...new Set(configured.split(",").map(host => host.trim()).filter(Boolean))];
  if (hosts.length === 0) throw new Error("HOSTS must contain at least one address");
  return hosts;
}

export interface GatewayAuthOptions {
  deviceToken: string;
  oauth: VeronicaOAuthConfig;
  verifier?: OAuthTokenVerifier;
}

export function createGatewayApp(auth: GatewayAuthOptions, broker = new Broker()) {
  const host = resolveListenHosts()[0];
  const app = createMcpExpressApp({ host, allowedHosts: resolveAllowedHosts() });
  app.use(express.json({ limit: "2mb" }));

  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "veronica" }));
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json(protectedResourceMetadata(auth.oauth));
  });

  const deviceAuth = requireDeviceToken(auth.deviceToken);
  app.post("/device/register", deviceAuth, (req, res) => {
    try {
      const input = registerDeviceSchema.parse(req.body);
      const deviceId = broker.registerDevice(input.name, input.platform);
      res.status(201).json({ deviceId });
    } catch (error) {
      res.status(statusForError(error)).json({ error: toWorkerError(error) });
    }
  });

  app.post("/device/poll", deviceAuth, async (req, res) => {
    try {
      const input = pollDeviceSchema.parse(req.body);
      const job = await broker.pollDevice(input.deviceId, input.waitMs);
      res.json({ job });
    } catch (error) {
      res.status(statusForError(error)).json({ error: toWorkerError(error) });
    }
  });

  app.post("/device/result", deviceAuth, (req, res) => {
    try {
      const input = submitResultSchema.parse(req.body);
      const accepted = broker.completeJob(input.deviceId, input.jobId, input.result);
      res.json({ accepted });
    } catch (error) {
      res.status(statusForError(error)).json({ error: toWorkerError(error) });
    }
  });

  app.use(
    "/mcp",
    requireBearerAuth({
      verifier: auth.verifier ?? new JwtAccessTokenVerifier(auth.oauth),
      requiredScopes: auth.oauth.scopes,
      resourceMetadataUrl: resourceMetadataUrl(auth.oauth)
    })
  );

  app.post("/mcp", async (req: Request, res: Response) => {
    const server = createVeronicaMcpServer(broker);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Veronica MCP request failed", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null
        });
      }
    }
  });

  app.all("/mcp", (_req, res) => {
    res.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Method not allowed" },
      id: null
    });
  });

  return app;
}

export function startServer() {
  const deviceToken = process.env.VERONICA_DEVICE_TOKEN ?? process.env.VERONICA_TOKEN;
  if (!deviceToken || deviceToken.length < 32) {
    throw new Error("VERONICA_DEVICE_TOKEN must be set to a random value of at least 32 characters");
  }

  const hosts = resolveListenHosts();
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);

  const app = createGatewayApp({ deviceToken, oauth: resolveOAuthConfig() });
  return hosts.map(host =>
    app.listen(port, host, () => {
      console.error(`Veronica gateway listening on http://${host}:${port}`);
    })
  );
}

export function isMainModule(
  entrypoint: string | undefined,
  moduleUrl: string,
  canonicalize: (value: string) => string = realpathSync
): boolean {
  if (!entrypoint) return false;
  return canonicalize(path.resolve(entrypoint)) === canonicalize(fileURLToPath(moduleUrl));
}

if (isMainModule(process.argv[1], import.meta.url)) startServer();
