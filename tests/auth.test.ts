import assert from "node:assert/strict";
import { test } from "node:test";
import { buildJobCookie, cookieName, generateToken, hashToken, presentedToken, tokenMatches } from "@/server/jobs/auth";

const id = "8a6e0804-2bd0-4672-b79d-d97027f5b0b6";

test("tokens verify against their stored hash only", () => {
  const token = generateToken();
  const stored = hashToken(token);
  assert.ok(tokenMatches(token, stored));
  assert.equal(tokenMatches(generateToken(), stored), false);
  assert.equal(stored.includes(token), false);
});

test("token is read from the job cookie or a bearer header", () => {
  const fromCookie = new Request("http://x/", { headers: { cookie: `other=1; ${cookieName(id)}=abc` } });
  assert.equal(presentedToken(fromCookie, id), "abc");

  const fromHeader = new Request("http://x/", { headers: { authorization: "Bearer xyz" } });
  assert.equal(presentedToken(fromHeader, id), "xyz");

  const otherJob = new Request("http://x/", { headers: { cookie: `${cookieName("other")}=abc` } });
  assert.equal(presentedToken(otherJob, id), undefined);
});

test("cookie is HttpOnly, SameSite=Strict, scoped to the job, and Secure behind https", () => {
  const plain = buildJobCookie(new Request("http://localhost/"), id, "t", 60_000);
  assert.match(plain, /HttpOnly/);
  assert.match(plain, /SameSite=Strict/);
  assert.match(plain, new RegExp(`Path=/api/jobs/${id}`));
  assert.doesNotMatch(plain, /Secure/);

  const proxied = new Request("http://localhost/", { headers: { "x-forwarded-proto": "https" } });
  assert.match(buildJobCookie(proxied, id, "t", 60_000), /Secure/);
});
