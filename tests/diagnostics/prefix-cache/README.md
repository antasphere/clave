# Legacy prefix-cache diagnostics

Frozen from internal P2 checkpoint 5151c41e9e1fc746def610f4cd45db60ed6186f1.
The original sources and full history remain at that Git commit. P4 removes
the custom wrapper/parser from the shipping graph; this directory keeps the
actual algorithm for legacy units and the original SSR dependency diagnostic.
Native cache diagnostics live in tests/e2e/diagnostics/prefix-cache to preserve
their original plain-JavaScript lint policy. The E2E runner discovers top-level
*.spec.mjs only. They describe the retired cache-bearing native source, not
the new shipping full renderer. No old finding is passed or waived here.

The original locations were plugins/chat-view/src/MarkdownMessage.tsx and
markdown-parser-reuse.ts, plus tests/e2e/native-parser-{path.spec,checks}.mjs
and markdown-parser-lifecycle{.spec,-fixture}.mjs. The P4 archive-manifest.json
records original hashes and reversible path substitutions. Original assertions
are unchanged. Legacy units still run under normal unchanged Vitest discovery.

The real locked SSR diagnostic is still executable with:

    node_modules/.bin/vitest run --config scripts/diagnostics/react-ssr-deep.config.ts -t 'does not add a deep phrasing' --reporter=verbose

It remains a known unresolved dependency failure, PRDCT-3634. Reverse-normalized
original source SHA256 is cf3f5117023b0aa6f3638bfd9b0d4f6f68ae4ddbd7572aa435bda5a99574089b.
Neither a retained diagnostic unit pass nor retired shorter-tail/store/Fiber
claims establish current native correctness or resource/performance acceptance.
