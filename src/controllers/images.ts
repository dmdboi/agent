import { Context } from "hono";
import { DockerService } from "../services/Docker";
import { BuildService } from "../services/BuildService";
import { info, error as logError } from "../utils/console";
import { handleError } from "../utils/error";

interface PullOptions {
  name: string;
}

interface CreateImageOptions {
  name: string;
  tag: string;
  applicationId: string;
  deploymentId: string;
  token: string;
  push?: { image: string; registry?: string; username?: string; password?: string };
}

export function createImageHandlers(dockerService: DockerService, buildService: BuildService) {
  if (!dockerService) throw new Error("Docker service is required");
  if (!buildService) throw new Error("Build service is required");

  async function list(ctx: Context) {
    try {
      const images = await dockerService.listImages();
      info("Image", "Listed images");
      return ctx.json(images);
    } catch (err) {
      return handleError(ctx, err, "Image", "list images");
    }
  }

  async function get(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      const image = await dockerService.getImage(id);
      return ctx.json(image);
    } catch (err) {
      return handleError(ctx, err, "Image", "get image", { id: ctx.req.param("id") });
    }
  }

  async function pull(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as PullOptions;

      info("Image", "Pulling image", { name: options.name });
      await dockerService.pullImage(options.name);

      info("Image", "Pulled image", { name: options.name });

      return ctx.json({ success: true, message: "image pulled", image: { name: options.name } });
    } catch (err) {
      return handleError(ctx, err, "Image", "pull image");
    }
  }

  async function build(ctx: Context) {
    try {
      const options = (await ctx.req.json()) as CreateImageOptions;
      const { name, tag, applicationId, deploymentId } = options;

      info("Image", "Build requested", { name, tag, applicationId, deploymentId });

      // Fire-and-forget: BuildService reports completion/failure to CORE_URL itself,
      // since a clone + build can outlast the caller's HTTP timeout.
      buildService.buildFromRepo(options).catch(err => {
        logError("Image", "Unhandled build error", { name, tag, applicationId, error: (err as Error).message });
      });

      return ctx.json({ success: true, message: "build started", image: { name, tag, applicationId } }, 202);
    } catch (err) {
      return handleError(ctx, err, "Image", "start image build");
    }
  }

  async function remove(ctx: Context) {
    try {
      const id = ctx.req.param("id");
      const force = ctx.req.query("force") === "true";
      await dockerService.removeImage(id, force);
      return ctx.json({ success: true, message: "image removed" });
    } catch (err) {
      return handleError(ctx, err, "Image", "remove image", { id: ctx.req.param("id") });
    }
  }

  async function prune(ctx: Context) {
    try {
      const all = ctx.req.query("all") === "true";

      const result = await dockerService.pruneImages(all);

      info("Image", "Pruned images", { all, spaceReclaimed: result.SpaceReclaimed });

      return ctx.json({
        success: true,
        space_reclaimed: result.SpaceReclaimed ?? 0,
        images_deleted: result.ImagesDeleted ?? [],
      });
    } catch (err) {
      return handleError(ctx, err, "Image", "prune images");
    }
  }

  return {
    list,
    get,
    pull,
    build,
    remove,
    prune,
  };
}
