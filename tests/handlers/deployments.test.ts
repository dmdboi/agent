import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { zValidator } from "@hono/zod-validator";

import { createDeploymentHandlers } from "../../src/controllers/deployments";
import { createDeploymentSchema } from "../../src/validators/Deployments";
import { makeApp } from "../helpers/makeApp";

vi.mock("../../src/utils/console", () => ({ info: vi.fn(), error: vi.fn(), warn: vi.fn(), success: vi.fn(), _setLogger: vi.fn() }));

describe("Deployment Handlers", () => {
  let server: import("http").Server;
  let mockDeployService: { deploy: ReturnType<typeof vi.fn> };
  let closeFn: (() => Promise<void>) | null = null;

  beforeEach(async () => {
    mockDeployService = { deploy: vi.fn().mockResolvedValue(undefined) };
    const handlers = createDeploymentHandlers(mockDeployService as never);
    const s = await makeApp(
      app => {
        app.post("/deployments", zValidator("json", createDeploymentSchema), handlers.deploy);
      },
      { auth: false },
    );

    server = s.server;
    closeFn = s.close;
  });

  afterEach(async () => {
    if (closeFn) await closeFn();
    vi.clearAllMocks();
  });

  const payload = {
    deployment_id: "dep_1",
    container: { name: "app-1", image: "ghcr.io/acme/app:1", networks: ["traefik"] },
    health: { port: 8000 },
    retire: ["old-1"],
  };

  it("returns 202 immediately and starts the deployment detached", async () => {
    const response = await request(server).post("/deployments").send(payload);

    expect(response.status).toBe(202);
    expect(response.body).toMatchObject({ success: true, deploymentId: "dep_1" });
    expect(mockDeployService.deploy).toHaveBeenCalledWith(
      expect.objectContaining({
        deploymentId: "dep_1",
        strategy: "rolling",
        retire: ["old-1"],
        health: { path: "/up", port: 8000, timeoutSeconds: 120, intervalSeconds: 3 },
      }),
    );
  });

  it("passes an optional stop_grace_seconds through as stopGraceSeconds", async () => {
    await request(server)
      .post("/deployments")
      .send({ ...payload, stop_grace_seconds: 15 });

    expect(mockDeployService.deploy).toHaveBeenCalledWith(expect.objectContaining({ stopGraceSeconds: 15 }));
  });

  it("passes separate runtime and prestep labels through request validation unchanged", async () => {
    const runtimeLabels = {
      "io.serversinc.agent.application_id": "app-1",
      "io.serversinc.agent.deployment_id": "dep_1",
      "io.serversinc.agent.workload_role": "runtime",
      "traefik.enable": "true",
    };
    const prestepLabels = {
      "io.serversinc.agent.application_id": "app-1",
      "io.serversinc.agent.deployment_id": "dep_1",
      "io.serversinc.agent.workload_role": "prestep",
    };

    const response = await request(server).post("/deployments").send({
      ...payload,
      container: { ...payload.container, labels: runtimeLabels },
      prestep: { run: true, command: ["true"], labels: prestepLabels },
    });

    expect(response.status).toBe(202);
    const [options] = mockDeployService.deploy.mock.calls[0];
    expect(options.container.labels).toEqual(runtimeLabels);
    expect(options.prestep).toEqual({ run: true, command: ["true"], labels: prestepLabels });
  });

  it("rejects a stop_grace_seconds above the 600s ceiling", async () => {
    const response = await request(server)
      .post("/deployments")
      .send({ ...payload, stop_grace_seconds: 601 });

    expect(response.status).toBe(400);
    expect(mockDeployService.deploy).not.toHaveBeenCalled();
  });

  it("defaults strategy to rolling and retire to an empty list", async () => {
    await request(server)
      .post("/deployments")
      .send({ deployment_id: "dep_2", container: { name: "a", image: "i", networks: [] } });

    expect(mockDeployService.deploy).toHaveBeenCalledWith(expect.objectContaining({ strategy: "rolling", retire: [] }));
  });

  it("rejects a body with no deployment_id", async () => {
    const response = await request(server)
      .post("/deployments")
      .send({ container: { name: "a", image: "i", networks: [] } });

    expect(response.status).toBe(400);
    expect(mockDeployService.deploy).not.toHaveBeenCalled();
  });

  it("rejects a body with no container", async () => {
    const response = await request(server).post("/deployments").send({ deployment_id: "dep_3" });

    expect(response.status).toBe(400);
    expect(mockDeployService.deploy).not.toHaveBeenCalled();
  });

  it("still responds 202 if the detached deployment rejects asynchronously", async () => {
    mockDeployService.deploy.mockRejectedValue(new Error("boom"));

    const response = await request(server).post("/deployments").send(payload);

    expect(response.status).toBe(202);
  });
});
