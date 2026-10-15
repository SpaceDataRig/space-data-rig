// Admin-gate tests (audit #1; default-deny per audit-10 #7): bearer-token authorization for mutating endpoints.
// Pure + offline. Run with: npm test
import { test } from "node:test";
import assert from "node:assert/strict";

import { timingSafeEqualStr, bearerToken, isAdminAuthorized } from "../src/core/auth.ts";

test("timingSafeEqualStr matches equal strings and rejects differences", () => {
  assert.equal(timingSafeEqualStr("secret-token", "secret-token"), true);
  assert.equal(timingSafeEqualStr("secret-token", "secret-tokeX"), false);
  assert.equal(timingSafeEqualStr("abc", "abcd"), false);
  assert.equal(timingSafeEqualStr("", ""), true);
});

test("bearerToken extracts the token and ignores other schemes", () => {
  assert.equal(bearerToken("Bearer abc123"), "abc123");
  assert.equal(bearerToken("bearer   abc123  "), "abc123");
  assert.equal(bearerToken("Basic xyz"), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken(""), null);
});

test("the gate is CLOSED by default when no admin token is configured (default-deny, audit-10 #7)", () => {
  assert.equal(isAdminAuthorized(undefined, undefined), false);
  assert.equal(isAdminAuthorized(undefined, ""), false);
  assert.equal(isAdminAuthorized("Bearer whatever", ""), false, "no secret set -> nothing is authorized");
});

test("when a token is configured, only an exact bearer match is authorized", () => {
  assert.equal(isAdminAuthorized("Bearer s3cr3t", "s3cr3t"), true);
  assert.equal(isAdminAuthorized(undefined, "s3cr3t"), false, "missing header is rejected");
  assert.equal(isAdminAuthorized("", "s3cr3t"), false);
  assert.equal(isAdminAuthorized("Bearer wrong", "s3cr3t"), false);
  assert.equal(isAdminAuthorized("s3cr3t", "s3cr3t"), false, "raw token without Bearer scheme is rejected");
  assert.equal(isAdminAuthorized("Bearer s3cr3tX", "s3cr3t"), false, "longer token rejected");
});
