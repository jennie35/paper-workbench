# Synthetic PDF fixtures

These tiny files were generated for this project's tests with ReportLab, Pillow
and pypdf. They are not papers or user research files, contain no API key or
personal data, and are distributed under this project's MIT license.

- `cjk-reference-with-blank.pdf`: a Chinese/English text page using the standard
  `STSong-Light` CID font, followed by a blank page. Exercises the vendored CMaps.
- `english-reference.pdf`: one page of synthetic English text using Helvetica.
- `scan-only.pdf`: one image page with a synthetic sentence; has no text layer.
- `encrypted-reference.pdf`: an encrypted copy of the English fixture. The test
  password is `fixture-password`; tests deliberately do not supply it.

The integration test uses the actual vendored PDF.js text core with its Node
fake worker and local CMap/font file reads. It does not test browser Worker
loading, content security policy, browser file selection, rendering or OCR.
