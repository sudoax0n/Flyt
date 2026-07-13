from pathlib import Path

app_path = Path("source app folder/dashboard/src/App.jsx")
source = app_path.read_text(encoding="utf-8")

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

replacements = [
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

for old, new in replacements:
    count = source.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one occurrence, found {count}: {old[:80]!r}")
    source = source.replace(old, new, 1)

app_path.write_text(source, encoding="utf-8")
print("Applied historic verification and timestamp integration patches.")
