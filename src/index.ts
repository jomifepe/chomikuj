import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { z } from "zod";
import dotenv from "dotenv";
import FormData from "form-data";
import fs from "fs";
import path from "path";
import { Command } from "commander";

dotenv.config();

const EnvSchema = z.object({
  CHOMIKUJ_USERNAME: z.string(),
  CHOMIKUJ_PASSWORD: z.string(),
});

const jar = new CookieJar();
const fetch = makeFetchCookie(globalThis.fetch, jar);

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://chomikuj.pl",
};

async function getRequestVerificationToken(): Promise<string> {
  console.log("Fetching homepage to get verification token...");
  const response = await fetch("https://chomikuj.pl/", {
    headers: DEFAULT_HEADERS,
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  const token = $('input[name="__RequestVerificationToken"]').val();

  if (!token || typeof token !== "string") {
    throw new Error("Could not find __RequestVerificationToken on homepage");
  }

  console.log("Token found:", token.substring(0, 10) + "...");
  return token;
}

async function login(token: string, env: z.infer<typeof EnvSchema>) {
  console.log("Logging in...");
  const params = new URLSearchParams();
  params.append("Login", env.CHOMIKUJ_USERNAME);
  params.append("Password", env.CHOMIKUJ_PASSWORD);
  params.append("__RequestVerificationToken", token);
  params.append("ReturnUrl", `/${env.CHOMIKUJ_USERNAME}`);

  const response = await fetch("https://chomikuj.pl/action/Login/TopBarLogin", {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://chomikuj.pl/${env.CHOMIKUJ_USERNAME}`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Login failed with status ${response.status}`);
  }

  console.log("Logged in successfully.");
}

const GetUrlResponseSchema = z.object({
  Url: z.string(),
  ChomikId: z.number(),
  FolderId: z.number(),
  AnonymousUpload: z.boolean(),
});

async function getUploadUrl(token: string, env: z.infer<typeof EnvSchema>, folderId: string): Promise<string> {
  console.log(`Getting upload URL for folder ${folderId}...`);
  const params = new URLSearchParams();
  params.append("accountname", env.CHOMIKUJ_USERNAME);
  params.append("folderid", folderId);
  params.append("__RequestVerificationToken", token);

  const response = await fetch("https://chomikuj.pl/action/Upload/GetUrl/", {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `https://chomikuj.pl/${env.CHOMIKUJ_USERNAME}`,
      "X-Requested-With": "XMLHttpRequest",
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Failed to get upload URL: ${response.status}`);
  }

  const json = await response.json();
  console.log("GetUrl response:", json);
  const data = GetUrlResponseSchema.parse(json);

  console.log("Upload URL obtained:", data.Url);
  return data.Url;
}

async function uploadFile(uploadUrl: string, filePath: string) {
  console.log(`Uploading file: ${filePath}...`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const form = new FormData();
  const fileName = path.basename(filePath);
  const fileStream = fs.createReadStream(filePath);

  form.append("files[]", fileStream, { filename: fileName });

  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      ...form.getHeaders(),
      Referer: "https://chomikuj.pl/",
    },
    body: form as unknown as BodyInit,
  });

  if (!response.ok) {
    throw new Error(`Upload failed with status ${response.status}`);
  }

  const responseBody = await response.text();
  console.log("Upload complete!");
  console.log("Response:", responseBody);
}

const program = new Command();

program
  .name("chomikuj-uploader")
  .description("Upload files to chomikuj.pl")
  .version("1.0.0")
  .argument("<file>", "file to upload")
  .option("-f, --folder <id>", "folder ID to upload to", "0")
  .action(async (file, options) => {
    try {
      const env = EnvSchema.parse(process.env);
      const token = await getRequestVerificationToken();
      await login(token, env);
      const uploadUrl = await getUploadUrl(token, env, options.folder);
      await uploadFile(uploadUrl, file);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

program.parse();
