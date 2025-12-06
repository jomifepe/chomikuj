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
import { PassThrough, Transform } from "stream";

dotenv.config();

const baseUrl = "https://chomikuj.pl";

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

const tempFiles = new Set<string>();

function registerTempFile(filePath: string): void {
  tempFiles.add(filePath);
}

function unregisterTempFile(filePath: string): void {
  tempFiles.delete(filePath);
}

function cleanupTempFiles(): void {
  for (const filePath of tempFiles) {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up temp file: ${filePath}`);
      }
    } catch (error) {
      console.warn(`Failed to clean up temp file ${filePath}:`, error);
    }
  }
  tempFiles.clear();
}

function setupCleanupHandlers(): void {
  process.on("exit", cleanupTempFiles);
  process.on("SIGINT", () => {
    cleanupTempFiles();
    process.exit(130);
  });
  process.on("SIGTERM", () => {
    cleanupTempFiles();
    process.exit(143);
  });
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    cleanupTempFiles();
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("Unhandled rejection:", reason);
    cleanupTempFiles();
    process.exit(1);
  });
}

setupCleanupHandlers();

export const cookieJar = new CookieJar();
const fetch = makeFetchCookie(globalThis.fetch, cookieJar);

const DEFAULT_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: baseUrl,
  "sec-ch-ua": '"Chromium";v="143", "Not A(Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  priority: "u=1, i",
};

export async function getRequestVerificationToken(url: string = baseUrl): Promise<string[]> {
  console.log(`Fetching ${url} to get verification token...`);
  const response = await fetch(url, {
    headers: DEFAULT_HEADERS,
  });
  const html = await response.text();
  const $ = cheerio.load(html);
  const tokens = $('input[name="__RequestVerificationToken"]');
  console.log(`Found ${tokens.length} verification tokens.`);

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
  params.append("ReturnUrl", `/${env.CHOMIKUJ_USERNAME}`);
  params.append("Login", env.CHOMIKUJ_USERNAME);
  params.append("Password", env.CHOMIKUJ_PASSWORD);
  for (let i = 0; i < tokens.length; i++) {
    params.append(`__RequestVerificationToken`, tokens[i]);
  }

  const response = await fetch(`${baseUrl}/action/Login/TopBarLogin`, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${baseUrl}/${env.CHOMIKUJ_USERNAME}`,
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
  for (let i = 0; i < tokens.length; i++) {
    params.append(`__RequestVerificationToken`, tokens[i]);
  }

  const response = await fetch(`${baseUrl}/action/Upload/GetUrl/`, {
    method: "POST",
    headers: {
      ...DEFAULT_HEADERS,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: `${baseUrl}/${env.CHOMIKUJ_USERNAME}`,
    },
    body: params,
  });

  if (!response.ok) {
    throw new Error(`Failed to get upload URL: ${response.status}`);
  }

  const data = GetUrlResponseSchema.parse(await response.json());

  console.log("Upload URL obtained:", data.Url);
  return data.Url;
}

export async function uploadFile(uploadUrl: string, filePath: string, customFileName?: string): Promise<string> {
  const stats = await fs.promises.stat(filePath);
  const fileSize = stats.size;

  const extension = path.extname(filePath);
  let fileName = path.basename(filePath);

  if (customFileName) {
    if (customFileName.endsWith(extension)) {
      fileName = customFileName;
    } else {
      fileName = customFileName + extension;
    }
  }

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

  const cookies = await cookieJar.getCookieString(uploadUrl);

  const headers: Record<string, string> = {
    "User-Agent": DEFAULT_HEADERS["User-Agent"],
    "Accept-Language": DEFAULT_HEADERS["Accept-Language"],
    Origin: baseUrl,
    Referer: baseUrl,
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

const headersSchema = z.record(z.string(), z.record(z.string(), z.string()));

function normalizeMimeType(mimeType: string): string {
  return mimeType.split(";")[0].trim().toLowerCase();
}

export async function downloadTempFile(url: string, expectedMimeType?: string): Promise<string> {
  const MAX_REDIRECTS = 10;

  const parsedUrl = new URL(url);
  const hostname = parsedUrl.hostname;

  let headers: HeadersInit = { ...DEFAULT_HEADERS };

  if (fs.existsSync("headers.json")) {
    try {
      const parsed = headersSchema.safeParse(JSON.parse(fs.readFileSync("headers.json", "utf8")));
      if (parsed.success) {
        const matchingHeaders = parsed.data[hostname];
        if (matchingHeaders) {
          headers = { ...headers, ...matchingHeaders };
          console.log(`Found headers for domain ${hostname}`);
        }
      }
    } catch {
      console.warn(`Could not parse header.json for domain ${hostname}, skipping...`);
    }
  }

  let currentUrl = url;
  let redirectCount = 0;
  // Follow redirects manually with limit
  while (redirectCount < MAX_REDIRECTS) {
    if (redirectCount === 0) {
      console.log(`Downloading from ${currentUrl}...`);
    } else {
      console.log(`Following redirect ${redirectCount} to ${currentUrl}...`);
    }

    const response = await fetch(currentUrl, {
      headers,
      redirect: "manual",
    });

    // Check if it's a redirect
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new Error(`Redirect response (${response.status}) missing Location header`);
      }

      redirectCount++;
      if (redirectCount >= MAX_REDIRECTS) {
        throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
      }

      // Resolve relative URLs
      currentUrl = new URL(location, currentUrl).href;
      continue;
    }

    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    // Check MIME type if expected
    if (expectedMimeType) {
      const contentType = response.headers.get("content-type");
      if (!contentType) {
        throw new Error(`No Content-Type header found in response, cannot verify MIME type`);
      }

      const actualMimeType = normalizeMimeType(contentType);
      const expectedNormalized = normalizeMimeType(expectedMimeType);

      if (actualMimeType !== expectedNormalized) {
        throw new Error(`MIME type mismatch: expected "${expectedMimeType}" but got "${contentType}"`);
      }

      console.log(`MIME type verified: ${contentType}`);
    }

    // Extract file extension from URL
    const urlPathname = new URL(currentUrl).pathname;
    const tempPath = path.join(os.tmpdir(), path.basename(urlPathname));
    registerTempFile(tempPath);
    console.log(`Downloading file to ${tempPath}...`);

    // Get content length for progress tracking
    const contentLength = response.headers.get("content-length");
    const totalBytes = contentLength ? parseInt(contentLength, 10) : null;

    let downloadedBytes = 0;
    let lastLoggedProgress = 0;

    if (totalBytes) {
      console.log(`Download progress: 0% (0/${totalBytes} bytes)`);
    } else {
      console.log(`Downloading file (size unknown)...`);
    }

    // Create a transform stream to track progress
    const progressStream = new Transform({
      transform(chunk: Buffer, encoding, callback) {
        downloadedBytes += chunk.length;
        if (totalBytes) {
          const progress = Math.round((downloadedBytes / totalBytes) * 100);
          if ((progress - lastLoggedProgress >= 5 || progress === 100) && lastLoggedProgress !== 100) {
            console.log(`Download progress: ${progress}% (${downloadedBytes}/${totalBytes} bytes)`);
            lastLoggedProgress = progress;
          }
        } else {
          // Log every 1MB if size is unknown
          if (downloadedBytes % (1024 * 1024) < chunk.length) {
            const mbDownloaded = (downloadedBytes / (1024 * 1024)).toFixed(2);
            console.log(`Downloaded: ${mbDownloaded} MB`);
          }
        }
        callback(null, chunk);
      },
    });

    const fileStream = fs.createWriteStream(tempPath);
    // @ts-expect-error - body is a ReadableStream
    await pipeline(response.body, progressStream, fileStream);

    if (totalBytes) {
      console.log(`Download complete: ${downloadedBytes}/${totalBytes} bytes`);
    } else {
      const mbDownloaded = (downloadedBytes / (1024 * 1024)).toFixed(2);
      console.log(`Download complete: ${mbDownloaded} MB`);
    }
    console.log(`Downloaded to ${tempPath}`);
    return tempPath;
  }

  throw new Error(`Redirect loop detected after ${MAX_REDIRECTS} redirects`);
}

const VALID_MIME_TYPES = [
  // Text
  "text/plain",
  "text/html",
  "text/css",
  "text/javascript",
  "text/csv",
  "text/xml",
  "text/markdown",
  // Images
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/bmp",
  "image/tiff",
  "image/x-icon",
  // Audio
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  // Video
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/x-msvideo",
  "video/webm",
  "video/ogg",
  // Documents
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  // Archives
  "application/zip",
  "application/x-zip-compressed",
  "application/x-rar-compressed",
  "application/x-7z-compressed",
  "application/gzip",
  "application/x-tar",
  // Code
  "application/json",
  "application/xml",
  "application/javascript",
  "application/typescript",
  // Other
  "application/octet-stream",
  "application/x-binary",
] as const;

function isValidMimeType(mimeType: string): boolean {
  const normalized = normalizeMimeType(mimeType);
  return VALID_MIME_TYPES.includes(normalized as (typeof VALID_MIME_TYPES)[number]);
}

interface CommandOptions {
  folder: string;
  name?: string;
  mimetype?: string;
}

const program = new Command();

program
  .name("chomikuj-uploader")
  .description("Upload files to Chomikuj.pl")
  .version("1.0.0")
  .argument("<file>", "file path or URL to upload")
  .requiredOption("-f, --folder <id>", "folder ID to upload to")
  .option("-n, --name <name>", "custom filename for the upload")
  .option("-m, --mimetype <type>", "expected MIME type (only for URL downloads)")
  .action(async (input: string, options: CommandOptions) => {
    try {
      if (import.meta.url === `file://${process.argv[1]}`) {
        if (!input) {
          console.error("Error: File path or URL must be provided");
          process.exit(1);
        }

        // Validate mimetype if provided
        if (options.mimetype) {
          if (!isValidMimeType(options.mimetype)) {
            console.error(`Error: Invalid MIME type "${options.mimetype}"`);
            console.error(`Valid MIME types: ${VALID_MIME_TYPES.join(", ")}`);
            process.exit(1);
          }
        }

        // Only run if executed directly
        const env = EnvSchema.parse(process.env);
        const tokens = await getRequestVerificationToken();
        await login(tokens, env);

        // Refresh token from profile page (often needed)
        const profileUrl = `${baseUrl}/${env.CHOMIKUJ_USERNAME}`;
        const newTokens = await getRequestVerificationToken(profileUrl);

        const folderId = options.folder; // Default to root folder if not specified
        const uploadUrl = await getUploadUrl(newTokens, env, folderId);

        if (input.startsWith("http")) {
          const tempPath = await downloadTempFile(input, options.mimetype);
          try {
            await uploadFile(uploadUrl, tempPath, options.name);
          } finally {
            if (fs.existsSync(tempPath)) {
              fs.unlinkSync(tempPath);
              unregisterTempFile(tempPath);
              console.log(`Deleted temp file: ${tempPath}`);
            }
          }
        } else {
          if (options.mimetype) {
            console.warn("Warning: --mimetype option is only used for URL downloads, ignoring for local file");
          }
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
