# alarm-scheduler

A job scheduler built on claydo. The `scheduler` kind stores named jobs in
its own SQLite database and multiplexes them over the instance's single
alarm: the alarm is always armed for the earliest job, and each alarm
invocation runs one due job, records it, and re-arms for the next. The
tests exercise the library's alarm semantics: natural delivery, re-arming
from inside the handler, at-least-once retry after a throwing handler, and
`deleteAll()` keeping a pending alarm.

## Kinds

- `scheduler` — schedule/cancel/list named jobs; fired jobs land in a
  `fired` table in firing order.

## Run the tests

From the repository root:

```sh
npx vitest run --config examples/alarm-scheduler/vitest.config.ts
```
