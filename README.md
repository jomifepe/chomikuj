# Chomikuj Uploader

A tool for uploading files to [chomikuj.pl](https://chomikuj.pl), a Polish file hosting service.

## Usage

### Requirements

- Node.js (ES modules support)
- Valid chomikuj.pl account credentials

### Configuration

Build the tool:

```bash
npm install
npm run build
```

Copy the `.env.example` file to `.env` and fill in your chomikuj.pl credentials:

```env
CHOMIKUJ_USERNAME=your_username
CHOMIKUJ_PASSWORD=your_password
```

### Upload a local file

```bash
npm start -- path/to/file.txt -f 19
```

### Upload a remote file

```bash
npm start -- https://example.com/file.pdf -f 19
```

### Remote file headers

You can provide custom headers for the remote file download in the `headers.json` file. This is useful if the file is behind a login wall.

```json
{
  "example.com": {
    "Cookie": "key=value; key2=value2;",
    "Accept": "image/webp"
  }
}
```

## Options

- `-f, --folder <id>` - (Required) Folder ID to upload to (default: "0" for root folder)
- `-n, --name [name]` - (Optional) Custom filename for the upload (extension will be preserved)
- `-m, --mimetype [mimetype]` - (Optional) Custom MIME type for the downloaded file

## Development

### Scripts

```bash
npm run build # Build the project
npm run start # Run the project
npm run dev # Run the project in watch mode
npm run lint # Lint the project
npm run lint:fix # Fix linting errors
npm run format # Format the project
npm run test # Run tests
```

## License

MIT
