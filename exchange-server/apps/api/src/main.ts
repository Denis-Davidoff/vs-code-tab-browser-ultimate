import { originChecksDisabled } from "./origin-policy.js";
import "reflect-metadata";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { toNodeHandler } from "better-auth/node";
import express from "express";
import { ApiController } from "./controller.js";
import { Services } from "./services.js";
import { Relay } from "./relay.js";
@Module({ controllers: [ApiController], providers: [Services, Relay] })
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
  app.use("/api/auth", toNodeHandler(services.auth));
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
        res.status(403).json({ message: "Origin not allowed" });
        return;
      }
      next();
    },
  );
  app.use(express.json({ limit: "128kb" }));
  await app.init();
  app.get(Relay).attach(app.getHttpServer());
  await app.listen(
    Number(process.env.PORT ?? 3001),
    process.env.HOST ?? "127.0.0.1",
  );
}
void main();
