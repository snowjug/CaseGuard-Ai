# Synthetic ingestion examples

Every file in this folder is **synthetic demonstration data**. All organisations (`contoso-synthetic`, `fabrikam-synthetic`), people, users and incidents are fictional; e-mail addresses use the reserved `.invalid` domain and IP addresses are RFC 1918 or RFC 5737 documentation ranges. The only real host names are the public Microsoft sign-in endpoints that the troubleshooting story mentions.

| File                                | Format            | What it shows                                                                                                                                                 |
| ----------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `transcript-teams-signin-proxy.txt` | Pasted transcript | The "one proxy node saturated after a TLS inspection change" story as e-mails (`From:`/`Sent:`/`Subject:`), a quoted reply, chat-style notes and a KQL result |
| `events-teams-signin-proxy.csv`     | CSV export        | A shorter variant of the same story as a spreadsheet: quoted commas, escaped quotes, an embedded line break, action columns and reply links                   |
| `minimal-case-bundle.json`          | JSON case bundle  | The smallest valid `caseguard.case-bundle/1` document (3 events, no resolution)                                                                               |

Each example is parsed by a test (`packages/domain/test/ingest-parsers-examples.test.ts`) and analysed end to end by the deterministic engine, so a change that breaks one of them fails the build.

## Pasted transcripts

`parsePastedTranscript(text, options)` accepts, in any mixture:

- `[2026-03-09 09:12] Customer: ...`, `2026-03-09T09:12:00Z - Engineer - ...`, `09:12 Customer: ...` (needs a date line or the `defaultDate` option), `(2026-03-09 09:12 UTC) Support: ...`
- e-mail blocks starting with `From:` followed by `Sent:` or `Date:` and optionally `Subject:`; `Re:` subjects link a reply to its thread
- `On <date>, <name> wrote:` replies: the quoted history is removed and only the new reply is kept
- lines before the first message such as `Title:`, `Reference:`, `Product:`, `Workload:`, `Severity:`, `Status:`, `Customer alias:`
- a qualifier after the speaker to state the event type, for example `Support Engineer (case note):` or `Support Engineer (query output):`

Nothing is invented. A stamp without a time zone is read as UTC (or `assumedUtcOffsetMinutes`) **and reported**; a stamp without a date takes the date line, `defaultDate` or, as a last resort, the injected clock **and says so**; an unreadable role becomes an "Unidentified Participant" instead of a guess; ambiguous dates such as `03/09/2026` are refused unless `dateOrder` is given. Speakers are replaced by pseudonymous aliases (`Support Engineer 1`), so names never reach the bundle.

## CSV files

`parseCsvEvents(csv, options)` expects a header row. Header names are matched case-insensitively with common aliases, for example `Timestamp`/`Time`/`Date`/`When`, `Participant`/`Author`/`From`/`Speaker`, `Role`, `Type`/`Event type`, `Subject`/`Title`, `Body`/`Message`/`Text`, `Action`, `Customer effort`, `In reply to`, `Id`. Comma, semicolon and tab delimiters are detected. Cells starting with `=`, `+`, `-`, `@`, a tab or a carriage return are stored with a leading `'` and reported (CSV/formula injection).

## Limits

Transcripts: 200,000 characters, 20,000 lines, 2,000 messages. CSV and JSON: 2 MiB. CSV: 2,000 rows, 40 columns, 20,000 characters per cell. JSON: nesting depth 16, 200,000 values. Every limit produces a friendly error that names the row and column or the JSON path.

## JSON Schemas

The downloadable JSON Schemas live in `synthetic-data/knowledge/` and `docs/schemas/` (case bundle, knowledge pack, SkillDNA content). Regenerate them with `pnpm schemas:export`; `pnpm schemas:export -- --check` fails when the committed files are out of date.

## Embedded copies in the API

The API container ships only the bundle, so it cannot read these files at run time. `apps/api/src/samples/generated.ts` embeds the two sample cases (`synthetic-data/cases/`) and the three example files of this folder; they are served by `GET /api/v1/samples` (loaded through the normal ingestion pipeline), `GET /api/v1/examples` and `GET /api/v1/examples/:exampleId`. After changing any of those files run `pnpm samples:export`; `pnpm samples:export -- --check` (and a test in `apps/api`) fails when the embedded copy is out of date.
