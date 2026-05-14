import test from "node:test";
import assert from "node:assert/strict";

import { isPendingDeviceAuthorization, pollDeadline, resolveVerificationUrl } from "../src/cli/login.js";

test("resolveVerificationUrl falls back to the Codex device authorization page", () => {
  assert.equal(resolveVerificationUrl({}), "https://auth.openai.com/codex/device");
});

test("pollDeadline supports absolute expires_at timestamps", () => {
  assert.equal(pollDeadline({ expires_at: "2026-05-14T23:02:01.000Z" }, 1_768_799_000_000), 1_778_799_721_000);
});

test("isPendingDeviceAuthorization treats current pending statuses as non-fatal", () => {
  assert.equal(isPendingDeviceAuthorization(403, { error: { code: "deviceauth_authorization_unknown" } }), true);
  assert.equal(isPendingDeviceAuthorization(404, { error: { code: "deviceauth_authorization_unknown" } }), true);
  assert.equal(isPendingDeviceAuthorization(200, { error: "authorization_pending" }), true);
  assert.equal(isPendingDeviceAuthorization(400, { error: "invalid_request" }), false);
});
