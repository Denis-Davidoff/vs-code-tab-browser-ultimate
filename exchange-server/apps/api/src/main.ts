import { originChecksDisabled } from "./origin-policy.js";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { SecurityController } from "./security/controller.js";
import { requestIdentity } from "./security/audit.js";
import { ApiController } from "./controller.js";
import { Services } from "./services.js";
import { Relay } from "./relay.js";
@Module({
  controllers: [ApiController, SecurityController],
  providers: [Services, Relay],
})
class AppModule {}
async function main() {
  if (
    !process.env.DATABASE_URL ||
    !process.env.BETTER_AUTH_URL ||
    !process.env.WEB_ORIGIN ||
    (process.env.BETTER_AUTH_SECRET?.length ?? 0) < 32
  )
    throw new Error(
      "Set DATABASE_URL, BETTER_AUTH_URL, WEB_ORIGIN and BETTER_AUTH_SECRET (32+ characters) in .env",
    );
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  app.enableShutdownHooks();
  const services = app.get(Services);
  await services.audit.init();
  // Auth uses its own body parser. Keep security metadata in request-local context.
  app.use(
    "/api/auth",
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const metadata = requestIdentity(req);
      // Overwrite the private header, even if supplied by an untrusted client.
      req.headers["x-exchange-client-ip"] = metadata.ip ?? "";
      res.once("finish", () => {
        if (res.statusCode >= 400)
          services.audit.background(
            services.audit.record({
              ...metadata,
              event: "auth.request.denied",
              outcome: res.statusCode < 500 ? "denied" : "error",
              reason: `http_${res.statusCode}`,
            }),
          );
      });
      services.audit.requestContext.run(metadata, () =>
        toNodeHandler(services.auth)(req, res),
      );
    },
  );
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (
        !originChecksDisabled() &&
        !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
        req.headers.origin !== process.env.WEB_ORIGIN
      ) {
        services.audit.background(
          services.audit.record({
            ...requestIdentity(req),
            event: "request.origin.denied",
            outcome: "denied",
          }),
        );
        res.status(403).json({ message: "Origin not allowed" });
        return;
      }
      next();
    },
  );
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      res.once("finish", () => {
        if (res.statusCode < 400) return;
        services.audit.background(
          (async () => {
            const identity = await services
              .identity(req.headers)
              .catch(() => undefined);
            await services.audit.record({
              ...requestIdentity(req),
              userId: identity?.userId,
              authSessionId: identity?.sessionId,
              event: "request.denied",
              outcome: res.statusCode < 500 ? "denied" : "error",
              reason: `http_${res.statusCode}`,
            });
          })(),
        );
      });
      next();
    },
  );
  app.use(express.json({ limit: "128kb" }));
  const plugins = express.Router();
  const requireIdentity: express.RequestHandler = (req, res, next) => {
    void services
      .identity(req.headers)
      .then((identity) => {
        res.locals.identity = identity;
        res.locals.metadata = requestIdentity(req);
        next();
      })
      .catch(() => res.status(401).json({ message: "Sign in required" }));
  };
  await services.plugins.load({
    pool: services.pool,
    audit: services.audit,
    router: plugins,
    requireIdentity,
  });
  app.use("/api/plugins", plugins);
  app.use(
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      const match = /^\/api\/points(?:\/([0-9a-f-]{36})(?:\/(key))?)?$/.exec(
        req.path,
      );
      if (match && ["POST", "DELETE"].includes(req.method)) {
        res.once("finish", () => {
          void services
            .identity(req.headers)
            .then((identity) =>
              services.audit.record({
                ...requestIdentity(req),
                userId: identity.userId,
                authSessionId: identity.sessionId,
                pointId: match[1],
                event:
                  req.method === "DELETE"
                    ? "workspace.deleted"
                    : match[2]
                      ? "workspace.key.rotated"
                      : "workspace.created",
                outcome: res.statusCode < 400 ? "success" : "denied",
                reason: `http_${res.statusCode}`,
              }),
            )
            .catch(() => {});
        });
      }
      next();
    },
  );
  await app.init();
  app.get(Relay).attach(app.getHttpServer());
  await app.listen(
    Number(process.env.PORT ?? 3001),
    process.env.HOST ?? "127.0.0.1",
  );
}
void main();
