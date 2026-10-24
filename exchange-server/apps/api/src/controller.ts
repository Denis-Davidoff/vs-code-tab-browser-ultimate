import {
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  Req,
  BadRequestException,
  NotFoundException,
} from "@nestjs/common";
import type { Request } from "express";
import { and, eq } from "drizzle-orm";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { createPointSchema } from "@exchange/protocol";
import { Relay } from "./relay.js";
import { Services } from "./services.js";
import { point } from "./schema.js";

@Controller("api")
export class ApiController {
  constructor(
    @Inject(Services) private readonly services: Services,
    @Inject(Relay) private readonly relay: Relay,
  ) {}
  @Get("health") health() {
    return { status: "ok", protocolVersion: 1 };
  }
  @Get("points") async list(@Req() req: Request) {
    const userId = await this.services.owner(req.headers);
    const rows = await this.services.db
      .select({
        id: point.id,
        name: point.name,
        createdAt: point.createdAt,
        encryption: point.encryption,
      })
      .from(point)
      .where(eq(point.userId, userId));
    return rows.map(({ encryption, ...row }) => ({
      ...row,
      protected: Boolean(encryption),
      online: this.relay.online(row.id),
      address: this.relay.address(row.id) ?? null,
    }));
  }
  @Get("points/:id") async details(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const userId = await this.services.owner(req.headers);
    const [row] = await this.services.db
      .select({ id: point.id, name: point.name, encryption: point.encryption })
      .from(point)
      .where(and(eq(point.id, id), eq(point.userId, userId)));
    if (!row) throw new NotFoundException();
    return {
      ...row,
      encryption: row.encryption ? JSON.parse(row.encryption) : null,
    };
  }
  @Post("points") async create(@Req() req: Request, @Body() body: unknown) {
    const userId = await this.services.owner(req.headers);
    const input = createPointSchema.safeParse(body);
    if (!input.success)
      throw new BadRequestException("Name must contain 1–100 characters");
    const key = "exch_" + randomBytes(32).toString("base64url");
    const [created] = await this.services.db
      .insert(point)
      .values({
        id: randomUUID(),
        userId,
        name: input.data.name,
        keyHash: createHash("sha256").update(key).digest("hex"),
      })
      .returning({
        id: point.id,
        name: point.name,
        createdAt: point.createdAt,
      });
    return { ...created, key };
  }
  @Post("points/:id/key") async rotate(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const userId = await this.services.owner(req.headers);
    const key = "exch_" + randomBytes(32).toString("base64url");
    const rows = await this.services.db
      .update(point)
      .set({ keyHash: createHash("sha256").update(key).digest("hex") })
      .where(and(eq(point.id, id), eq(point.userId, userId)))
      .returning({ id: point.id });
    if (!rows.length) throw new NotFoundException();
    this.relay.disconnectPoint(id);
    return { key };
  }
  @Delete("points/:id") async remove(
    @Req() req: Request,
    @Param("id") id: string,
  ) {
    const userId = await this.services.owner(req.headers);
    const deleted = await this.services.db
      .delete(point)
      .where(and(eq(point.id, id), eq(point.userId, userId)))
      .returning({ id: point.id });
    if (!deleted.length) throw new NotFoundException();
    this.relay.disconnectPoint(id);
    return { deleted: true };
  }
}
