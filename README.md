# BookBug

A lightweight Chinese e-reader that runs entirely in the browser. No server required.

## Features

- **Vertical text layout** — traditional right-to-left Chinese typesetting
- **Simplified → Traditional** Chinese conversion (powered by OpenCC-js)
- **Read zipped books directly** — no need to unzip; supports GB18030/GBK encoded text files
- **Text-to-speech** — listen to book content using the Web Speech API
- **URL bookmarks** — share your reading position across browsers via URL
- **Zero backend** — static files only, hosted on GitHub Pages

## Usage

1. Drop a zipped `.txt` book file into the `books/` folder
2. Open the app and select your book
3. Read!

Bookmarks are encoded in the URL — copy and paste it to resume reading on any device.

## Local Development

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Tech Stack

| Component | Solution |
|-----------|----------|
| Unzip | [fflate](https://github.com/101arrowz/fflate) (client-side) |
| Text encoding | `TextDecoder('gb18030')` (browser built-in) |
| SC → TC | [OpenCC-js](https://github.com/nk2028/opencc-js) |
| TTS | Web Speech API (browser built-in) |
| Vertical layout | CSS `writing-mode: vertical-rl` |
| Hosting | GitHub Pages |

## License

MIT
