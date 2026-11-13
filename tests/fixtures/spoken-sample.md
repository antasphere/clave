## The importer is fixed

The nightly import stopped on Tuesday because the parser refused a date written with a two-digit year. I changed it to read both forms, and every import since then has finished.

| Job | State | Duration |
| --- | --- | --- |
| Nightly import | Green | 4 minutes |
| Weekly report | Green | 11 minutes |
| Archive sweep | Skipped | none |

To check it yourself:

```sh
npm run import -- --dry-run --since 2026-01-01
```

What changed:

- The date reader in `src/import/dates.ts` now accepts two-digit years.
- A test covers the case, see [the importer tests](https://example.com/importer-tests).
- **No data** was lost: the failed runs wrote nothing.

Next: run the dry run once and tell me if the counts look right.
