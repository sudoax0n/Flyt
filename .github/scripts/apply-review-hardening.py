from pathlib import Path

app_path = Path("source app folder/dashboard/src/App.jsx")
app_source = app_path.read_text(encoding="utf-8")

old_verification = """    if (!runId) {
      try {
        const verRes = await fetch(`/api/verification?t=${cacheBust}`, { cache: 'no-store' });
        if (verRes.ok) {
          const verData = await verRes.json();
          (verData.reviews || []).forEach((r) => {
            reviews[r.event_id] = r;
          });
        }
      } catch { /* keep empty reviews */ }
    }
"""
new_verification = """    try {
      const verificationUrl = runId
        ? `/api/verification?runId=${encodeURIComponent(runId)}&t=${cacheBust}`
        : `/api/verification?t=${cacheBust}`;
      const verRes = await fetch(verificationUrl, { cache: 'no-store' });
      if (verRes.ok) {
        const verData = await verRes.json();
        (verData.reviews || []).forEach((r) => {
          reviews[r.event_id] = r;
        });
      }
    } catch { /* keep empty reviews */ }
"""

app_replacements = [
    (old_verification, new_verification),
    (
        "  const loadHistoricRun = async (runId) => {\n",
        "  const loadHistoricRun = async (run) => {\n    const runId = run.runId;\n",
    ),
    (
        "    setRunTimestamp(new Date().toISOString());\n",
        "    setRunTimestamp(run.timestamp || null);\n",
    ),
    (
        "onClick={() => loadHistoricRun(run.runId)}",
        "onClick={() => loadHistoricRun(run)}",
    ),
]

for old, new in app_replacements:
    count = app_source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one App.jsx occurrence, found {count}: {old[:80]!r}")
    app_source = app_source.replace(old, new, 1)

app_path.write_text(app_source, encoding="utf-8")

server_path = Path("source app folder/dashboard/server.js")
server_source = server_path.read_text(encoding="utf-8")
server_replacements = [
    (
        "    runTracker: options.services?.runTracker || async (inputPath, outputs, overrides, context) => runCommand(\n",
        "    runTracker: options.services?.runTracker || ((inputPath, outputs, overrides, context) => runCommand(\n",
    ),
    (
        "        onStderr: (text) => console.error(`[Tracker] ${text.trim()}`),\n      },\n    ),\n    transcode:",
        "        onStderr: (text) => console.error(`[Tracker] ${text.trim()}`),\n      },\n    )),\n    transcode:",
    ),
]

for old, new in server_replacements:
    count = server_source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one server.js occurrence, found {count}: {old[:80]!r}")
    server_source = server_source.replace(old, new, 1)

server_path.write_text(server_source, encoding="utf-8")
Path(".github/eslint-diagnostics.json").unlink(missing_ok=True)
print("Applied frontend integration and server parser hardening patches.")
