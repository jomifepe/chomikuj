import { describe, it, expect, beforeAll } from "vitest";
import {
  getRequestVerificationToken,
  login,
  getUploadUrl,
  uploadFile,
  downloadTempFile,
  EnvSchema,
  jar,
} from "./index.ts";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { z } from "zod";

type EnvSchema = z.infer<typeof EnvSchema>;

dotenv.config();

describe("Chomikuj Uploader Integration", () => {
  let env: EnvSchema;
  let uploadUrl: string;

  beforeAll(async () => {
    // 1. Validate Env
    env = EnvSchema.parse(process.env);
    expect(env.CHOMIKUJ_USERNAME).toBeDefined();
    expect(env.CHOMIKUJ_PASSWORD).toBeDefined();

    // 2. Get Verification Token (Initial)
    console.log("Fetching https://chomikuj.pl/ to get verification token...");
    const tokens = await getRequestVerificationToken();
    expect(tokens.length).toBeGreaterThan(0);
    console.log(`Found ${tokens.length} tokens.`);

    // 3. Login
    console.log("Logging in...");
    await login(tokens, env);
    console.log("Logged in successfully.");

    // Verify cookies
    const cookieString = await jar.getCookieString("https://chomikuj.pl");
    expect(cookieString).toContain("ChomikSession");

    // Refresh token from profile page
    console.log(`Fetching https://chomikuj.pl/${env.CHOMIKUJ_USERNAME} to get verification token...`);
    const profileUrl = `https://chomikuj.pl/${env.CHOMIKUJ_USERNAME}`;
    const newTokens = await getRequestVerificationToken(profileUrl);
    expect(newTokens.length).toBeGreaterThan(0);
    console.log(`Found ${newTokens.length} tokens.`);

    // 4. Get Upload URL
    // Use folder 19 (test folder)
    console.log("Getting upload URL for folder 19...");
    uploadUrl = await getUploadUrl(newTokens, env, "19");
    expect(uploadUrl).toBeDefined();
    expect(uploadUrl).toMatch(/^https?:\/\//);
    console.log("Upload URL obtained:", uploadUrl);
  }, 60000);

  it("should upload local a file", async () => {
    // 5. Upload File (Local)
    const testFilePath = path.resolve(__dirname, "../test.txt");
    if (!fs.existsSync(testFilePath)) {
      fs.writeFileSync(testFilePath, "Integration test content");
    }

    console.log(`Uploading file: ${testFilePath}...`);
    const customName = "custom-test-file"; // No extension provided
    const fileUrl = await uploadFile(uploadUrl, testFilePath, customName);

    expect(fileUrl).toBeDefined();
    expect(typeof fileUrl).toBe("string");
    expect(fileUrl).toContain("/darrelllance/"); // Basic check based on username
    expect(fileUrl).toContain("custom-test-file"); // Check if custom name is in URL
    expect(fileUrl).toMatch(/custom-test-file.*\.txt$/); // Ensure extension is preserved at the end
  }, 60000);

  it("should download and upload a file", async () => {
    // 6. Upload File (URL)
    const publicFileUrl = "https://www.google.com/robots.txt";
    // Fallback to robots.txt if the above doesn't exist (since I can't verify the user's repo content)
    // But let's try the user's request first, corrected.

    console.log(`Downloading and uploading from URL: ${publicFileUrl}...`);

    const tempPath = await downloadTempFile(publicFileUrl);
    try {
      const urlCustomName = "url-test-file";
      const urlFileUrl = await uploadFile(uploadUrl, tempPath, urlCustomName);

      expect(urlFileUrl).toBeDefined();
      expect(urlFileUrl).toContain("url-test-file");
      expect(urlFileUrl).toMatch(/url-test-file.*\.txt$/);
    } finally {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    }
  }, 60000);
});
