# 档案识读 · Archive OCR

A local archive manager for historians that runs entirely in your browser: OCR, document text extraction, a searchable library, notes, a chronology (年表) and theme summaries (主题). Your files and data stay on your computer (stored in the browser's IndexedDB). All libraries and language models are bundled in `vendor/`, so it works offline. Optionally, Google Gemini can be used as a more accurate cloud OCR engine (see 「Gemini 云端识别」 below).

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

## Gemini 云端识别（可选，推荐用于印刷档案）

**设置步骤**
1. 打开 <https://aistudio.google.com/apikey>，用 Google 账号登录，点击“Create API key”生成密钥（免费层即可使用，有每日次数限制）。
2. 在本工具 **设置 → Gemini 云端识别** 中粘贴 API Key，点击 **保存**，再点 **测试连接**，看到“✓ 连接成功”即可。
3. 模型默认 `gemini-3.8-flash`（速度快、成本低）。点 **获取可用模型** 可列出您的密钥能用的全部模型；也可选“其他模型（手动填写）”输入任意模型名。并发数默认 2。

**默认行为**
- 已保存 Gemini 密钥时，新导入的材料**默认使用 Gemini** 识别；未保存密钥时使用本地 Tesseract，并在导入页提示可在设置中添加密钥。
- 在导入页 **识别引擎** 中手动选择“Tesseract（本地，离线）”或“Gemini（云端，更准确）”后，该选择会被记住（localStorage），优先于上述默认。
- **Gemini 失败时自动改用 Tesseract** 默认开启：网络错误、配额用尽、服务繁忙等情况下，该页自动用 Tesseract 识别并在页面上注明原因。
- 若所选模型已被 Google 停用（404），工具会通过 ListModels 自动改用当前最新的 Flash 模型并提示。

**重新识别**
- 条目详情页：“Gemini 重识别本页”或用 Tesseract 重识别本页；多页条目可点“全部页用 Gemini 识别”。
- 档案库：点“多选”，勾选若干条目后点“用 Gemini 重新识别所选”。已手动修改过的页面会先询问是否覆盖。
- Gemini 识别的页面显示“引擎：Gemini”徽标（不提供置信度），每页记录所用引擎和模型，JSON 导出中也包含这两项。

**识别提示词**：要求逐字忠实转录——不做繁简转换、不改正错字、竖排按从右到左逐列阅读、保留分段、无法辨认的字用 □ 表示、印章/批注等用【印】【批注】标出、只输出正文不加说明。

**AI 摘要**：设置 → AI 中“服务商”可选 **Gemini**，复用同一密钥生成条目摘要、主题摘要和年表总结。

**隐私与注意事项**
- 使用 Gemini 时，页面图像（压缩为 JPEG）会发送到 Google 服务器识别；Tesseract 则完全在本机运行。涉及敏感或未公开档案时请慎用，或改用 Tesseract。免费层数据可能被 Google 用于改进产品，详见 Google 条款。
- 密钥只保存在本浏览器的 localStorage 中，**不会写入备份文件**；点“清除密钥”即可删除。
- 需要能访问 `generativelanguage.googleapis.com`；部分地区（如中国大陆）需要相应的网络环境，否则会显示网络错误并（若开启）自动改用 Tesseract。
- 免费层有每分钟和每日请求上限；服务繁忙（503）时最多重试 2 次，速率限制（429）按 Google 建议的时间重试，每日配额用尽则不再重试。每次重试都计入配额。
- 极少数情况下 Gemini 可能因安全策略或“背诵”（RECITATION，如与已出版文本高度一致）拒绝输出，此时会显示原因并可改用 Tesseract。

## Tests
`tests/gen.py` generates the sample files (in `tests/samples/`). `tests/e2e.mjs` is a Playwright end-to-end test (headless Chrome). It blocks every request that isn't to localhost, which confirms that no network access is needed. `tests/e2e-gemini.mjs` tests the Gemini integration against a mocked API (request shape, concurrency, retries, errors, fallback, model auto-switch, summaries, no key in backups). `tests/live-gemini.mjs` is an optional live test that reads a real key from a local file you supply.

## Limitations
- Tesseract handles clean printed text well (88–92% confidence on the test scans). It does poorly on handwriting, ornate or very degraded type, dense classical layouts, seals and marginal notes. Vertical text recognition is weaker than horizontal. Mixing chi_sim and chi_tra on one page can produce mixed character forms, so pick the one that matches the document.
- Theme analysis is statistical (bigrams). It gives useful leads but is noisy for very short texts. The AI option gives better summaries.
- Old .doc files: the extraction is a heuristic. Save them as .docx when you can. Encrypted PDFs and very large TIFFs may fail.
- Data lives in this browser's storage. Make regular backups, and click 申请持久存储 (request persistent storage) in 设置 (Settings).
