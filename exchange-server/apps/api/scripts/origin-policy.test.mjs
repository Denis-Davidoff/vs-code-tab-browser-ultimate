import test from "node:test";
import assert from "node:assert/strict";
import { originChecksDisabled } from "../src/origin-policy.ts";
test("origin checks require an explicit local opt-out", () => {
  assert.equal(originChecksDisabled({}), false);
  assert.equal(
    originChecksDisabled({ LOCAL_DISABLE_ORIGIN_CHECK: "false" }),
    false,
  );
  assert.equal(
    originChecksDisabled({ LOCAL_DISABLE_ORIGIN_CHECK: "true" }),
    true,
  );
  assert.equal(
    originChecksDisabled({
      LOCAL_DISABLE_ORIGIN_CHECK: "true",
      NODE_ENV: "development",
    }),
    true,
  );
});
test("production keeps origin checks even with the local flag", () => {
  assert.equal(
    originChecksDisabled({
      LOCAL_DISABLE_ORIGIN_CHECK: "true",
      NODE_ENV: "production",
    }),
    false,
  );
});
