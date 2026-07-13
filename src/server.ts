import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod/v4";
import { Broker } from "./broker.js";
import {
  DEFAULT_COMMAND_TIMEOUT_SECONDS,
  MAX_COMMAND_TIMEOUT_SECONDS,
  pollDeviceSchema,
  registerDeviceSchema,
  submitResultSchema
} from "./protocol.js";

const readValueSchema = z.object({ content: z.string() });
const writeValueSchema = z.object({ bytesWritten: z.number().int().nonnegative() });
const commandValueSchema = z.object({
  exitCode: z.number().int().nullable(),
  signal: z.string().nullable(),
  stdout: z.string(),
  stderr: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean()
});

function jsonResult(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value) }]
  };
}

function errorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }]
  };
}

export function createVeronicaMcpServer(broker: Broker): McpServer {
  const server = new McpServer(
    { name: "veronica", version: "0.0.0" },
    {
      instructions: [
        "Veronica routes a small set of coding operations to explicitly exposed local workspaces.",
        "Call list_devices, then open_workspace, then use the returned workspace_id.",
        "Veronica is an execution bridge, not an agent runtime."
      ].join(" ")
    }
  );

  server.registerTool(
    "list_devices",
    {
      title: "List Veronica devices",
      description: "List computers currently known to the Veronica gateway.",
      inputSchema: {},
      annotations: { readOnlyHint: true }
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
        path: z.string().min(1).default(".")
      }
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
      description: "Read a UTF-8 text file inside an open Veronica workspace.",
      inputSchema: {
        workspace_id: z.string().uuid(),
        path: z.string().min(1)
      },
      annotations: { readOnlyHint: true }
    },
    async ({ workspace_id: workspaceId, path: filePath }) => {
      try {
        const result = await broker.executeInWorkspace(workspaceId, workspace => ({
          type: "read_file",
          workspace,
          path: filePath
        }));
        if (!result.ok) return errorResult(result.error);
        const value = readValueSchema.parse(result.value);
        return jsonResult(value);
      } catch (error) {
        return errorResult(error);
      }
    }
  );

  server.registerTool(
    "write_file",
    {
      title: "Write workspace file",
      description: "Replace a UTF-8 text file inside an open Veronica workspace.",
      inputSchema: {
        workspace_id: z.string().uuid(),
        path: z.string().min(1),
        content: z.string()
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async ({ workspace_id: workspaceId, path: filePath, content }) => {
      try {
        const result = await broker.executeInWorkspace(workspaceId, workspace => ({
          type: "write_file",
          workspace,
          path: filePath,
          content
        }));
        if (!result.ok) return errorResult(result.error);
        return jsonResult(writeValueSchema.parse(result.value));
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
        command: z.string().min(1),
        timeout_seconds: z.number().int().min(1).max(MAX_COMMAND_TIMEOUT_SECONDS).default(DEFAULT_COMMAND_TIMEOUT_SECONDS)
      }
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
      annotations: { idempotentHint: true }
    },
    async ({ workspace_id: workspaceId }) => jsonResult({ closed: broker.closeWorkspace(workspaceId) })
  );

  return server;
}

function requireToken(token: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/healthz") {
      next();
      return;
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    next();
  };
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("Unknown device")) return 404;
  if (message.includes("already connected") || message.includes("active poll")) return 409;
  return 400;
}

export function resolveAllowedHosts(): string[] | undefined {
  const configured = process.env.VERONICA_ALLOWED_HOSTS;
  if (configured === undefined) return undefined;
  const hosts = [...new Set(configured.split(",").map(host => host.trim()).filter(Boolean))];
  if (hosts.length === 0) throw new Error("VERONICA_ALLOWED_HOSTS must contain at least one hostname");
  return hosts;
}

export function createGatewayApp(token: string, broker = new Broker()) {
  const host = process.env.HOST ?? "127.0.0.1";
  const app = createMcpExpressApp({ host, allowedHosts: resolveAllowedHosts() });
  app.use(express.json({ limit: "2mb" }));
  app.use(requireToken(token));

  app.get("/healthz", (_req, res) => res.json({ ok: true, service: "veronica" }));

  app.post("/device/register", (req, res) => {
    try {
      const input = registerDeviceSchema.parse(req.body);
      const deviceId = broker.registerDevice(input.name, input.platform);
      res.status(201).json({ deviceId });
    } catch (error) {
      res.status(statusForError(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/device/poll", async (req, res) => {
    try {
      const input = pollDeviceSchema.parse(req.body);
      const job = await broker.pollDevice(input.deviceId, input.waitMs);
      res.json({ job });
    } catch (error) {
      res.status(statusForError(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.post("/device/result", (req, res) => {
    try {
      const input = submitResultSchema.parse(req.body);
      broker.completeJob(input.deviceId, input.jobId, input.result);
      res.json({ ok: true });
    } catch (error) {
      res.status(statusForError(error)).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

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
  const token = process.env.VERONICA_TOKEN;
  if (!token || token.length < 32) {
    throw new Error("VERONICA_TOKEN must be set to a random value of at least 32 characters");
  }

  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid PORT: ${process.env.PORT}`);

  return createGatewayApp(token).listen(port, host, () => {
    console.error(`Veronica gateway listening on http://${host}:${port}`);
  });
}

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entrypoint === fileURLToPath(import.meta.url)) startServer();
