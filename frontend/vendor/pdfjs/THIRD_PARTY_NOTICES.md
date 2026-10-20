# Mozilla PDF.js

Vendored version: **6.4.299**, the official stable release verified on 2026-10-17.

- Upstream: https://github.com/mozilla/pdf.js/releases/tag/v6.4.299
- Distribution: https://registry.npmjs.org/pdfjs-dist/-/pdfjs-dist-6.4.299.tgz
- npm package metadata: https://registry.npmjs.org/pdfjs-dist/6.4.299
- Package SHA-512 integrity: `AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==`

The archive integrity was checked before extracting these files. The upstream
files are unmodified. Only `legacy/build/pdf.mjs`, `legacy/build/pdf.worker.mjs`, `cmaps/`,
`standard_fonts/`, the upstream README, package metadata and license were copied.
Source maps, the viewer, scripting sandbox, image decoders and other build assets
are not included. Runtime resources are served from this repository, with no CDN.
The official legacy ESM build includes its upstream compatibility polyfills.
The embedded core-js 3.50.0 polyfills are MIT licensed; their full upstream
license is retained in [LICENSE_CORE_JS](LICENSE_CORE_JS), copied from
https://github.com/zloirock/core-js/blob/v3.50.0/LICENSE.

PDF.js is under the Apache License 2.0; see [LICENSE](LICENSE). This license is
separate from Paper Workbench's MIT license. The Adobe CMaps and bundled font
files retain their own upstream notices:

- [CMap license](cmaps/LICENSE)
- [Foxit font license](standard_fonts/LICENSE_FOXIT)
- [Liberation font license](standard_fonts/LICENSE_LIBERATION)

The application uses PDF.js only to extract a user-selected local PDF's text in
a worker. It does not execute PDF scripts, open attachments, follow links, render
figures, perform OCR, or treat extracted text as a verified scientific reading.
