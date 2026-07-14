import { randomUUID } from "node:crypto";
import { VeronicaError, type DeviceJob, type WorkerRequest, type WorkerResult } from "./protocol.js";

const DEFAULT_DEVICE_ONLINE_WINDOW_MS = 60_000;
const DEFAULT_DEVICE_RETENTION_MS = 5 * 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 130_000;

type DeviceRecord = {
  id: string;
  name: string;
  platform: string;
  rootLabel: string;
  lastSeenAt: number;
  queue: DeviceJob[];
  wakePoll?: () => void;
};

type PendingJob = {
  deviceId: string;
  resolve: (result: WorkerResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type WorkspaceRecord = {
  id: string;
  deviceId: string;
  path: string;
};

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  rootLabel: string;
  online: boolean;
  lastSeenAt: string;
};

export type WorkspaceSummary = {
  id: string;
  deviceId: string;
  path: string;
};

export type BrokerOptions = {
  now?: () => number;
  deviceOnlineWindowMs?: number;
  deviceRetentionMs?: number;
};

export class Broker {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly devicesByName = new Map<string, string>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();
  private readonly now: () => number;
  private readonly deviceOnlineWindowMs: number;
  private readonly deviceRetentionMs: number;

  constructor(options: BrokerOptions = {}) {
    this.now = options.now ?? Date.now;
    this.deviceOnlineWindowMs = options.deviceOnlineWindowMs ?? DEFAULT_DEVICE_ONLINE_WINDOW_MS;
    this.deviceRetentionMs = options.deviceRetentionMs ?? DEFAULT_DEVICE_RETENTION_MS;
  }

  registerDevice(name: string, platform: string, rootLabel = name): string {
    this.pruneStaleDevices();
    const existingId = this.devicesByName.get(name);
    const now = this.now();
    if (existingId) {
      const existing = this.requireDevice(existingId);
      if (now - existing.lastSeenAt <= this.deviceOnlineWindowMs) {
        throw new VeronicaError("conflict", `Device name is already connected: ${name}`);
      }
      this.disconnectDevice(existingId, "Device reconnected");
    }

    const id = randomUUID();
    this.devices.set(id, {
      id,
      name,
      platform,
      rootLabel,
      lastSeenAt: now,
      queue: []
    });
    this.devicesByName.set(name, id);
    return id;
  }

  listDevices(): DeviceSummary[] {
    this.pruneStaleDevices();
    const now = this.now();
    return [...this.devices.values()]
      .map(device => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        rootLabel: device.rootLabel,
        online: now - device.lastSeenAt <= this.deviceOnlineWindowMs,
        lastSeenAt: new Date(device.lastSeenAt).toISOString()
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async pollDevice(deviceId: string, waitMs: number): Promise<DeviceJob | null> {
    const device = this.requireDevice(deviceId);
    device.lastSeenAt = this.now();

    const queued = this.takeQueuedJob(device);
    if (queued) return queued;
    if (waitMs === 0) return null;
    if (device.wakePoll) throw new VeronicaError("conflict", "Device already has an active poll");

    return await new Promise<DeviceJob | null>(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        device.wakePoll = undefined;
        device.lastSeenAt = this.now();
        resolve(this.takeQueuedJob(device));
      };
      const timer = setTimeout(finish, waitMs);
      device.wakePoll = finish;
    });
  }

  completeJob(deviceId: string, jobId: string, result: WorkerResult): boolean {
    this.requireDevice(deviceId).lastSeenAt = this.now();
    const pending = this.pendingJobs.get(jobId);
    if (!pending) return false;
    if (pending.deviceId !== deviceId) throw new VeronicaError("conflict", "Job belongs to another device");

    clearTimeout(pending.timer);
    this.pendingJobs.delete(jobId);
    pending.resolve(result);
    return true;
  }

  async openWorkspace(deviceName: string | undefined, path: string): Promise<WorkspaceSummary> {
    const device = this.selectOnlineDevice(deviceName);
    const result = await this.enqueue(device.id, { type: "open_workspace", path });
    if (!result.ok) throw new VeronicaError(result.error.code, result.error.message);

    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      deviceId: device.id,
      path
    };
    this.workspaces.set(workspace.id, workspace);
    return { id: workspace.id, deviceId: workspace.deviceId, path: workspace.path };
  }

  closeWorkspace(workspaceId: string): boolean {
    return this.workspaces.delete(workspaceId);
  }

  async executeInWorkspace(
    workspaceId: string,
    request: (workspacePath: string) => WorkerRequest,
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS
  ): Promise<WorkerResult> {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new VeronicaError("not_found", "Unknown or closed workspace");
    this.requireOnlineDevice(workspace.deviceId);
    return await this.enqueue(workspace.deviceId, request(workspace.path), timeoutMs);
  }

  private async enqueue(
    deviceId: string,
    request: WorkerRequest,
    timeoutMs = DEFAULT_JOB_TIMEOUT_MS
  ): Promise<WorkerResult> {
    const device = this.requireDevice(deviceId);
    const job: DeviceJob = { id: randomUUID(), request };

    const result = new Promise<WorkerResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingJobs.delete(job.id);
        const queuedIndex = device.queue.findIndex(candidate => candidate.id === job.id);
        if (queuedIndex >= 0) device.queue.splice(queuedIndex, 1);
        reject(new VeronicaError("timeout", "Device job timed out"));
      }, timeoutMs);
      this.pendingJobs.set(job.id, { deviceId, resolve, reject, timer });
    });

    device.queue.push(job);
    device.wakePoll?.();
    return await result;
  }

  private takeQueuedJob(device: DeviceRecord): DeviceJob | null {
    while (device.queue.length > 0) {
      const job = device.queue.shift();
      if (!job) return null;
      if (this.pendingJobs.has(job.id)) return job;
    }
    return null;
  }

  private selectOnlineDevice(deviceName: string | undefined): DeviceRecord {
    this.pruneStaleDevices();
    if (deviceName) {
      const deviceId = this.devicesByName.get(deviceName);
      if (!deviceId) throw new VeronicaError("not_found", `Unknown device: ${deviceName}`);
      return this.requireOnlineDevice(deviceId);
    }

    const online = [...this.devices.values()].filter(
      device => this.now() - device.lastSeenAt <= this.deviceOnlineWindowMs
    );
    if (online.length === 0) throw new VeronicaError("unavailable", "No Veronica devices are online");
    if (online.length > 1) {
      throw new VeronicaError(
        "conflict",
        `Multiple Veronica devices are online: ${online.map(device => device.name).sort().join(", ")}`
      );
    }
    return online[0]!;
  }

  private pruneStaleDevices(): void {
    const busyDeviceIds = new Set([...this.pendingJobs.values()].map(job => job.deviceId));
    const staleIds = [...this.devices.values()]
      .filter(
        device =>
          this.now() - device.lastSeenAt > this.deviceRetentionMs &&
          device.queue.length === 0 &&
          !busyDeviceIds.has(device.id)
      )
      .map(device => device.id);
    for (const deviceId of staleIds) this.disconnectDevice(deviceId, "Device record expired");
  }

  private requireDevice(deviceId: string): DeviceRecord {
    const device = this.devices.get(deviceId);
    if (!device) throw new VeronicaError("not_found", "Unknown device");
    return device;
  }

  private requireOnlineDevice(deviceId: string): DeviceRecord {
    const device = this.requireDevice(deviceId);
    if (this.now() - device.lastSeenAt > this.deviceOnlineWindowMs) {
      throw new VeronicaError("unavailable", `Device is offline: ${device.name}`);
    }
    return device;
  }

  private disconnectDevice(deviceId: string, reason: string): void {
    const device = this.devices.get(deviceId);
    if (!device) return;

    device.wakePoll?.();
    this.devices.delete(deviceId);
    if (this.devicesByName.get(device.name) === deviceId) this.devicesByName.delete(device.name);

    for (const [jobId, pending] of this.pendingJobs) {
      if (pending.deviceId !== deviceId) continue;
      clearTimeout(pending.timer);
      this.pendingJobs.delete(jobId);
      pending.reject(new VeronicaError("unavailable", reason));
    }

    for (const [workspaceId, workspace] of this.workspaces) {
      if (workspace.deviceId === deviceId) this.workspaces.delete(workspaceId);
    }
  }
}
