# Bilingual Text Generator

![License](https://img.shields.io/badge/license-CC%20BY--NC%204.0-blue.svg)
![Status](https://img.shields.io/badge/status-active-success.svg)
![Theme](https://img.shields.io/badge/theme-light%20%2F%20dark-blueviolet)

A powerful, client-side web application designed to merge English and French texts into perfectly aligned bilingual scripts. Ideal for speeches, presentations, and bilingual events where balanced timing and language alternation are crucial.

## Key Features

- **Speech Mode**: Automatically balances content based on time blocks.
  - **Smart Calculation**: "Optimal" mode calculates the best switch interval to keep languages balanced.
  - **Manual Control**: Fine-tune the duration of each language block (e.g., switch every 45 seconds).
- **Presentation Mode**: Aligns slides for bilingual decks.
  - **Single Language**: Alternates language per slide (Slide 1: EN, Slide 2: FR, etc.).
  - **Mixed Mode**: Splits each slide 50/50 (half EN, half FR).
  - **Pattern Control**: Choose between Alternating (A-B, B-A) or Repeating (A-B, A-B) patterns.
- **Robust Tools**:
  - **Formatting Helper**: Auto-formats raw text to add slide headers or clean up spacing.
  - **Live Statistics**: Real-time word counts and duration estimates based on WPM.
  - **Validation**: Smart checks for missing content or slide mismatches.
- **Modern UI**:
  - **Dark Mode**: Fully supported with system preference detection and manual toggle.
  - **Responsive**: Works brilliantly on desktops, tablets, and mobile devices.
  - **Bilingual Interface**: Toggle the entire app UI between English and French instantly.
- **Privacy First**: Runs entirely in your browser. No text is sent to any server.

## Usage

1.  **Open the App**: Simply open `index.html` in any modern web browser.
2.  **Enter Text**: Paste your English content on the left and French content on the right.
    - *Tip*: Use the "Load Example" buttons to see how it works instantly.
3.  **Choose Mode**:
    - **Speech**: Best for spoken scripts. Adjust the "Block Time" to control how often languages switch.
    - **Presentation**: Use `#` at the start of lines to denote new slides (e.g., `# Slide 1`).
4.  **Generate**: Click **Generate Bilingual Text**.
5.  **Export**: Review the preview, check the stats, and click **Copy to Clipboard** or **Download**.

### Input Formatting Guide

-   **Speech Mode**: Just ensure your paragraphs correspond roughly in both languages. The merger aligns them paragraph-by-paragraph.
-   **Presentation Mode**:
    ```text
    # Slide 1 Title
    Content for slide 1...

    # Slide 2 Title
    Content for slide 2...
    ```
    *Use the "Format Text" button to automatically add these headers if specific keywords like "Slide" or "Diapositive" are detected!*

## Project Structure

-   `index.html`: The main application structure.
-   `style.css`: All styling, including the expansive Dark Mode theme variables and responsive layout.
-   `script.js`: Core logic for text merging, validation, UI state management, and translation.
-   `examples/`: Sample text files for testing.

## Development

This project is built with **Vanilla HTML, CSS, and JavaScript**. No build tools, bundlers, or frameworks are required.

To make changes:
1.  Edit the files directly.
2.  Refresh your browser.
3.  (Optional) Use `TODO.md` to track planned improvements.

## License

Content is licensed under [CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/).
You are free to use and adapt this tool for non-commercial purposes with credit.
