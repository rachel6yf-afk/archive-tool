# 档案识读 · Archive OCR

A local archive manager for historians that runs entirely in your browser: OCR, document text extraction, a searchable library, notes, a chronology (年表) and theme summaries (主题). Your files and data stay on your computer (stored in the browser's IndexedDB). All libraries and language models are bundled in `vendor/`, so it works offline.

## How to run
```bash
cd archive-ocr
python3 serve.py          # then open http://localhost:8000  (python3 serve.py 8080 --open picks a port and opens the browser)
# or: python3 -m http.server 8000
```
You have to open it through a local server. Opening `index.html` directly with `file://` won't work, because Web Workers and WASM can't load that way. Use a recent Chrome, Edge, Firefox or Safari.

## Features
- **导入 Import**: drag and drop many files at once, or pick a whole folder. Images: JPG, PNG, TIFF (multi-page), WEBP, BMP, GIF and HEIC/HEIF (converted in the browser), plus multi-page PDFs. They are queued and OCR'd automatically by a pool of 1–4 Tesseract workers, with progress shown per file and per page. If a PDF already has a text layer, its text is used directly. Documents: .docx (mammoth), .xlsx/.xls/.csv/.ods (SheetJS), .txt, and .doc (experimental heuristic). An optional tag can be applied to each batch.
- **OCR settings**: Simplified Chinese + English by default. Traditional Chinese, Japanese, French, German, Spanish, Italian, Portuguese, Dutch, Russian and Latin can also be selected. The settings are tuned for printed text (LSTM engine, 300 dpi hint, small images upscaled). Vertical Chinese mode (竖排) uses chi_sim_vert/chi_tra_vert. Optional preprocessing: grayscale, auto-contrast, Otsu threshold, invert. Spaces that Tesseract inserts between CJK characters are removed.
- **档案库 Library**: grid or list view, with filters by text, type and tag, and sorting. Each item has a title, source file, type, thumbnail, editable full text (per page), dates, tags and notes. Export the current list as one merged .txt, a .zip (one .txt per item + results.json), per-page JSON (filename, page, text, confidence…) or .docx.
- **条目详情 Item detail**: the page image and editable text side by side, a confidence badge, low-confidence words marked on the image, page navigation, re-OCR of a page, a Traditional→Simplified conversion button, item notes and the item's own timeline entries.
- **笔记 Notes**: general notes. Select text in an item and click "引用到笔记" to quote it into a note with a link back to the source page. Notes can be linked to items and are searchable.
- **检索 Search**: substring matching for CJK text (no word splitting). Several keywords are combined with AND, and quoted phrases are supported. Simplified and Traditional characters match each other. Filters for type, tag and date range. Results show highlighted snippets. Export as .docx, .md or .txt.
- **年表 Timeline**: dates are extracted automatically from all text. Supported: 1937年7月7日, 一九三七年三月, Republic of China years (民国二十六年 → 1937), Qing reign years from 顺治 to 宣统 (光绪三十年 → 1904; lunar month and day are kept as written, not converted), Japanese era names 明治/大正/昭和, 1937-07-07, July 7, 1937, 7 May 1945, 7/7/1937 (read as M/D/Y), July 1937, and "in 1906". Each entry shows its sentence context and a link to the source. Entries can be added, edited or deleted, and deleted automatic entries stay deleted. Export as .csv, .xlsx, .docx, .md or .txt.
- **主题 Themes**: computed locally. TF-IDF over Chinese character bigrams (with stopword filtering) and English words, merged into longer phrases where possible, then grouped by similarity with tags as strong signals. Each theme shows its keywords, related items and representative excerpts. Items are also grouped by tag. Export as .docx, .md or .txt.
- **AI (optional)**: in 设置 (Settings), enter any OpenAI-compatible endpoint, key and model (OpenAI, DeepSeek, Qwen, or local Ollama/LM Studio) to get summaries per item, per theme and for the timeline. The key is kept only in localStorage and is never included in backups. Everything else works without it.
- **备份 Backup**: export the whole archive as one JSON file (items with images, notes, timeline, AI summaries) and import it again in any browser.

## Tests
`tests/gen.py` generates the sample files (in `tests/samples/`). `tests/e2e.mjs` is a Playwright end-to-end test (headless Chrome). It blocks every request that isn't to localhost, which confirms that no network access is needed.

## Limitations
- Tesseract handles clean printed text well (88–92% confidence on the test scans). It does poorly on handwriting, ornate or very degraded type, dense classical layouts, seals and marginal notes. Vertical text recognition is weaker than horizontal. Mixing chi_sim and chi_tra on one page can produce mixed character forms, so pick the one that matches the document.
- Theme analysis is statistical (bigrams). It gives useful leads but is noisy for very short texts. The AI option gives better summaries.
- Old .doc files: the extraction is a heuristic. Save them as .docx when you can. Encrypted PDFs and very large TIFFs may fail.
- Data lives in this browser's storage. Make regular backups, and click 申请持久存储 (request persistent storage) in 设置 (Settings).
