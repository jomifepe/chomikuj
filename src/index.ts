import makeFetchCookie from "fetch-cookie";
import { CookieJar } from "tough-cookie";
import * as cheerio from "cheerio";
import { z } from "zod";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { Command } from "commander";
import os from "os";
import { pipeline } from "stream/promises";
import { PassThrough } from "stream";

dotenv.config();

export const EnvSchema = z.object({
  CHOMIKUJ_USERNAME: z.string(),
  CHOMIKUJ_PASSWORD: z.string(),
});

const UploadResponseSchema = z.object({
  files: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      id: z.number(),
      fileId: z.number(),
      url: z.string(),
      folderName: z.string(),
    }),
  ),
});

const GetUrlResponseSchema = z.object({
  Url: z.string(),
  ChomikId: z.number(),
  FolderId: z.number(),
  AnonymousUpload: z.boolean(),
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
  const data = GetUrlResponseSchema.parse(json);

  console.log("Upload URL obtained:", data.Url);
  return data.Url;
}

export async function uploadFile(uploadUrl: string, filePath: string, customFileName?: string): Promise<string> {
  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;

  const ext = path.extname(filePath);
  let fileName = path.basename(filePath);

  if (customFileName) {
    if (customFileName.endsWith(ext)) {
      fileName = customFileName;
    } else {
      fileName = customFileName + ext;
    }
  }

  // Manually construct multipart body to avoid FormData issues and enable progress logging
  const boundary = "----WebKitFormBoundary" + Math.random().toString(36).substring(2);

  const pre = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
  );
  const post = Buffer.from(`\r\n--${boundary}--\r\n`);

  const totalLength = pre.length + fileSize + post.length;

  let uploadedBytes = 0;
  let lastLoggedProgress = 0;

  console.log(`Upload progress: 0% (0/${fileSize} bytes)`);

  const combinedStream = new PassThrough();
  combinedStream.write(pre);

  const fileStream = fs.createReadStream(filePath);

  fileStream.on("data", (chunk) => {
    uploadedBytes += chunk.length;
    const progress = Math.round((uploadedBytes / fileSize) * 100);
    if ((progress - lastLoggedProgress >= 5 || progress === 100) && lastLoggedProgress !== 100) {
      console.log(`Upload progress: ${progress}% (${uploadedBytes}/${fileSize} bytes)`);
      lastLoggedProgress = progress;
    }
  });

  fileStream.pipe(combinedStream, { end: false });
  fileStream.on("end", () => {
    combinedStream.write(post);
    combinedStream.end();
  });

  // Get cookies manually
  const cookies = await jar.getCookieString(uploadUrl);

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
    Origin: "https://chomikuj.pl",
    Referer: "https://chomikuj.pl/",
    Cookie: cookies,
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": totalLength.toString(),
  };

  const response = await globalThis.fetch(uploadUrl, {
    method: "POST",
    headers,
    // @ts-expect-error - duplex is required for stream bodies in Node fetch
    duplex: "half",
    body: combinedStream as unknown as BodyInit,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error("Upload error response:", errorText);
    throw new Error(`Upload failed with status ${response.status}`);
  }

  const json = await response.json();
  console.log("Upload complete!");

  const parsed = UploadResponseSchema.parse(json);
  if (parsed.files.length === 0) {
    throw new Error("No files returned in upload response");
  }

  const fileUrl = parsed.files[0].url;
  console.log("File URL:", fileUrl);

  return fileUrl;
}

export async function downloadTempFile(url: string): Promise<string> {
  console.log(`Downloading from ${url}...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const urlPath = new URL(url).pathname;
  const fileName = path.basename(urlPath) || `temp-${Date.now()}`;
  const tempPath = path.join(os.tmpdir(), fileName);

  const fileStream = fs.createWriteStream(tempPath);
  // @ts-expect-error - body is a ReadableStream
  await pipeline(response.body, fileStream);

  console.log(`Downloaded to ${tempPath}`);
  return tempPath;
}

interface CommandOptions {
  folder: string;
  name?: string;
}

const program = new Command();

program
  .name("chomikuj-uploader")
  .description("Upload files to Chomikuj.pl")
  .version("1.0.0")
  .argument("<file>", "file path or URL to upload")
  .requiredOption("-f, --folder <id>", "folder ID to upload to")
  .option("-n, --name <name>", "custom filename for the upload")
  .action(async (input: string, options: CommandOptions) => {
    try {
      if (import.meta.url === `file://${process.argv[1]}`) {
        if (!input) {
          console.error("Error: File path or URL must be provided");
          process.exit(1);
        }

        // Only run if executed directly
        const env = EnvSchema.parse(process.env);
        const tokens = await getRequestVerificationToken();
        await login(tokens, env);

        // Refresh token from profile page (often needed)
        const profileUrl = `https://chomikuj.pl/${env.CHOMIKUJ_USERNAME}`;
        const newTokens = await getRequestVerificationToken(profileUrl);

        const folderId = options.folder; // Default to root folder if not specified
        const uploadUrl = await getUploadUrl(newTokens, env, folderId);

        if (input.startsWith("http")) {
          const tempPath = await downloadTempFile(input);
          try {
            await uploadFile(uploadUrl, tempPath, options.name);
          } finally {
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
              console.log(`Deleted temp file: ${tempPath}`);
            }
          }
        } else {
          await uploadFile(uploadUrl, input, options.name);
        }
      }
    } catch (error) {
      console.error("Error:", error);
      process.exit(1);
    }
  });

if (import.meta.url.startsWith("file:")) {
  const modulePath = import.meta.url.slice(7); // Remove 'file://'
  if (modulePath === process.argv[1]) {
    program.parse();
  }
}
