from pathlib import Path

app_path = Path("source app folder/dashboard/src/App.jsx")
source = app_path.read_text(encoding="utf-8")

required_fragments = [
    "/api/verification?runId=${encodeURIComponent(runId)}",
    "setRunTimestamp(run.timestamp || null)",
    "onClick={() => loadHistoricRun(run)}",
]
for fragment in required_fragments:
    if fragment not in source:
        raise RuntimeError(f"Previously validated frontend integration is missing: {fragment}")

old_stats = """      const { detected, verified } = runId
        ? { detected: eventList.filter((e) => e.type === 'courtship_bout').length, verified: 0 }
        : computeCourtshipStats(eventList, reviews);
"""
new_stats = """      const { detected, verified } = computeCourtshipStats(eventList, reviews);
"""

count = source.count(old_stats)
if count != 1:
    raise RuntimeError(f"Expected one historic stats fallback, found {count}")
source = source.replace(old_stats, new_stats, 1)
app_path.write_text(source, encoding="utf-8")
Path(".github/eslint-diagnostics.json").unlink(missing_ok=True)
print("Applied historic verified-count integration patch.")
