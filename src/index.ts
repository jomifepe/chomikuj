import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Command } from "commander";

dotenv.config();

export const EnvSchema = z.object({
  CHOMIKUJ_USERNAME: z.string(),
  CHOMIKUJ_PASSWORD: z.string(),
});

export const jar = new CookieJar();
const fetch = makeFetchCookie(globalThis.fetch, jar);

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: "https://chomikuj.pl",
  "sec-ch-ua": '"Chromium";v="143", "Not A(Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  priority: "u=1, i",
};

export async function getRequestVerificationToken(url: string = "https://chomikuj.pl/"): Promise<string[]> {
  console.log(`Fetching ${url} to get verification token...`);
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  const tokens = $('input[name="__RequestVerificationToken"]');
  console.log(`Found ${tokens.length} tokens.`);

  const tokenValues: string[] = [];
  tokens.each((_, el) => {
    const val = $(el).val();
    if (typeof val === "string") {
      tokenValues.push(val);
    }
  });

  if (tokenValues.length === 0) {
    throw new Error("Could not find __RequestVerificationToken on homepage");
  }

  return tokenValues;
}

export async function login(tokens: string[], env: z.infer<typeof EnvSchema>) {
  console.log("Logging in...");
  const params = new URLSearchParams();
  // Match curl order: Token1, ReturnUrl, Login, Password, Token2 (if exists)
  if (tokens.length > 0) params.append("__RequestVerificationToken", tokens[0]);
  params.append("ReturnUrl", `/${env.CHOMIKUJ_USERNAME}`);
  params.append("Login", env.CHOMIKUJ_USERNAME);
  params.append("Password", env.CHOMIKUJ_PASSWORD);
  if (tokens.length > 1) params.append("__RequestVerificationToken", tokens[1]);

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

export async function getUploadUrl(
  tokens: string[],
  env: z.infer<typeof EnvSchema>,
  folderId: string,
): Promise<string> {
  console.log(`Getting upload URL for folder ${folderId}...`);
  const params = new URLSearchParams();
  params.append("accountname", env.CHOMIKUJ_USERNAME);
  params.append("folderid", folderId);
  // Assuming getUploadUrl just needs one token, usually the first one?
  if (tokens.length > 0) params.append("__RequestVerificationToken", tokens[0]);

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

export async function uploadFile(uploadUrl: string, filePath: string) {
  console.log(`Uploading file: ${filePath}...`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const fileName = path.basename(filePath);

  // Manually construct multipart body to avoid FormData issues
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);
  const fileContent = fs.readFileSync(filePath);

  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);

  const body = Buffer.concat([pre, fileContent, post]);

  // Get cookies manually
  const cookies = await jar.getCookieString(uploadUrl);

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
    Origin: "https://chomikuj.pl",
    Referer: "https://chomikuj.pl/",
    Cookie: cookies,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": body.length.toString(),
  };

  const response = await globalThis.fetch(uploadUrl, {
    method: "POST",
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Upload error response:", errorText);
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
      const tokens = await getRequestVerificationToken();
      await login(tokens, env);
      const uploadUrl = await getUploadUrl(tokens, env, options.folder);
      await uploadFile(uploadUrl, file);
    } catch (error) {
      console.error("Error:", error instanceof Error ? error.message : error);
      process.exit(1);
    }
  });

import { pathToFileURL } from "url";

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  program.parse();
}
