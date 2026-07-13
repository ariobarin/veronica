import { randomUUID } from "node:crypto";
import { VeronicaError, type DeviceJob, type WorkerRequest, type WorkerResult } from "./protocol.js";

const DEVICE_ONLINE_WINDOW_MS = 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 130_000;

type DeviceRecord = {
  id: string;
  name: string;
  platform: string;
  registeredAt: number;
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
  createdAt: number;
};

export type DeviceSummary = {
  id: string;
  name: string;
  platform: string;
  online: boolean;
  lastSeenAt: string;
};

export type WorkspaceSummary = {
  id: string;
  deviceId: string;
  path: string;
};

export class Broker {
  private readonly devices = new Map<string, DeviceRecord>();
  private readonly devicesByName = new Map<string, string>();
  private readonly pendingJobs = new Map<string, PendingJob>();
  private readonly workspaces = new Map<string, WorkspaceRecord>();

  registerDevice(name: string, platform: string): string {
    const existingId = this.devicesByName.get(name);
    const now = Date.now();
    if (existingId) {
      const existing = this.requireDevice(existingId);
      if (now - existing.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS) {
        throw new VeronicaError("conflict", `Device name is already connected: ${name}`);
      }
      this.disconnectDevice(existingId, "Device reconnected");
    }

    const id = randomUUID();
    this.devices.set(id, {
      id,
      name,
      platform,
      registeredAt: now,
      lastSeenAt: now,
      queue: []
    });
    this.devicesByName.set(name, id);
    return id;
  }

  listDevices(): DeviceSummary[] {
    const now = Date.now();
    return [...this.devices.values()]
      .map(device => ({
        id: device.id,
        name: device.name,
        platform: device.platform,
        online: now - device.lastSeenAt <= DEVICE_ONLINE_WINDOW_MS,
        lastSeenAt: new Date(device.lastSeenAt).toISOString()
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async pollDevice(deviceId: string, waitMs: number): Promise<DeviceJob | null> {
    const device = this.requireDevice(deviceId);
    device.lastSeenAt = Date.now();

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
        device.lastSeenAt = Date.now();
        resolve(this.takeQueuedJob(device));
      };
      const timer = setTimeout(finish, waitMs);
      device.wakePoll = finish;
    });
  }

  completeJob(deviceId: string, jobId: string, result: WorkerResult): boolean {
    this.requireDevice(deviceId).lastSeenAt = Date.now();
    const pending = this.pendingJobs.get(jobId);
    if (!pending) return false;
    if (pending.deviceId !== deviceId) throw new VeronicaError("conflict", "Job belongs to another device");

    clearTimeout(pending.timer);
    this.pendingJobs.delete(jobId);
    pending.resolve(result);
    return true;
  }

  async openWorkspace(deviceName: string, path: string): Promise<WorkspaceSummary> {
    const deviceId = this.devicesByName.get(deviceName);
    if (!deviceId) throw new VeronicaError("not_found", `Unknown device: ${deviceName}`);
    this.requireOnlineDevice(deviceId);

    const result = await this.enqueue(deviceId, { type: "open_workspace", path });
    if (!result.ok) throw new VeronicaError(result.error.code, result.error.message);

    const workspace: WorkspaceRecord = {
      id: randomUUID(),
      deviceId,
      path,
      createdAt: Date.now()
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

  private requireDevice(deviceId: string): DeviceRecord {
    const device = this.devices.get(deviceId);
    if (!device) throw new VeronicaError("not_found", "Unknown device");
    return device;
  }

  private requireOnlineDevice(deviceId: string): DeviceRecord {
    const device = this.requireDevice(deviceId);
    if (Date.now() - device.lastSeenAt > DEVICE_ONLINE_WINDOW_MS) {
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
