import test from "node:test";
import assert from "node:assert/strict";
import { commandSchema, createPointSchema } from "./index.ts";
test("remote commands reject arbitrary editor actions and extra payload", () => {
  assert.equal(
    commandSchema.safeParse({
      type: "executeCommand",
      command: "terminal.sendSequence",
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "chat.stop",
      id: crypto.randomUUID(),
      chatId: "chat",
      token: "secret",
    }).success,
    false,
  );
  assert.equal(
    commandSchema.safeParse({
      type: "chat.send",
      id: crypto.randomUUID(),
      chatId: "chat",
      text: "hello",
    }).success,
    true,
  );
});
test("point names are bounded and trimmed", () => {
  assert.equal(createPointSchema.parse({ name: "  Laptop  " }).name, "Laptop");
  assert.equal(
    createPointSchema.safeParse({ name: " ".repeat(10) }).success,
    false,
  );
});
