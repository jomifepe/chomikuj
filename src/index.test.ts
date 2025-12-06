import { describe, it, expect } from "vitest";
import { getRequestVerificationToken, login, getUploadUrl, uploadFile, EnvSchema, jar } from "./index.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

describe("Chomikuj Uploader Integration", () => {
  it("should upload a file successfully", async () => {
    // 1. Validate Env
    const env = EnvSchema.parse(process.env);
    expect(env.CHOMIKUJ_USERNAME).toBeDefined();
    expect(env.CHOMIKUJ_PASSWORD).toBeDefined();

    // 1. Set initial cookies
    await jar.setCookie("cookiesAccepted=1", "https://chomikuj.pl");

    // 2. Get Token
    const tokens = await getRequestVerificationToken();
    expect(tokens).toBeDefined();
    expect(Array.isArray(tokens)).toBe(true);
    expect(tokens.length).toBeGreaterThan(0);

    // 3. Login
    await login(tokens, env);

    // 3.5 Refresh Token from Profile Page
    const profileUrl = `https://chomikuj.pl/${env.CHOMIKUJ_USERNAME}`;
    const newTokens = await getRequestVerificationToken(profileUrl);
    expect(newTokens).toBeDefined();
    // expect(newTokens).not.toBe(tokens); // Arrays are reference types, so this is always true.

    // 4. Get Upload URL
    // Use folder 4 (from curl example)
    const uploadUrl = await getUploadUrl(newTokens, env, "4");
    expect(uploadUrl).toBeDefined();
    expect(uploadUrl).toMatch(/^https?:\/\//);

    // 5. Upload File
    const testFilePath = path.resolve(__dirname, "../test.txt");
    if (!fs.existsSync(testFilePath)) {
      fs.writeFileSync(testFilePath, "Integration test content");
    }

    await uploadFile(uploadUrl, testFilePath);

    // If we reach here without error, it passed.
  }, 60000); // Increase timeout for network requests
});
