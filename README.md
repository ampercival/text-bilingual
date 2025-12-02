# Bilingual Text Generator

Web app to merge aligned English and French content into balanced bilingual output. Supports speech (time-sliced) and presentation (slide-by-slide) workflows, with inline word/time stats, copy/download, and an EN/FR UI toggle.

## Features
- Speech mode with block-time tuning and automatic balancing of word counts/durations.
- Presentation mode: aligned `# Slide ...` headings; single or mixed language per slide.
- Live word counts and duration estimates; copy to clipboard or download as Markdown.
- Example loader buttons and a clear/reset action; fullscreen textarea expand.
- UI available in English and French with tooltips and formatting guidance.

## Usage
1. Open `index.html` in your browser.
2. Paste English and French text. Keep paragraphs aligned by position in both.
3. Choose mode, starting language, and slide language mode (presentation) or block time (speech).
4. Click **Generate Bilingual Text**, then copy or download the result.

### Formatting rules
- **Speech mode:** Plain text in both languages; paragraph positions must align (e.g., EN para 1 ↔ FR para 1).
- **Presentation mode:** Each slide begins with a heading line starting with `#` (e.g., `# Slide 1 - Title`). Paragraphs within a slide align by position across languages.

## Examples
Use the UI buttons to load examples from `examples/`:
- `examples/EN-Speech.txt`, `examples/FR-Speech.txt`
- `examples/EN-Presentation.txt`, `examples/FR-Presentation.txt`

## Development
- Static HTML/CSS/JS (no build step). Main files: `index.html`, `style.css`, `script.js`.
- Edit and reload to see changes.

## License
Content is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/); please credit the source for non-commercial use. Source code is available on GitHub.
