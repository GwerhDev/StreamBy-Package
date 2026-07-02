# /roadmap — Sync StreamBy Roadmap to Workspace

This skill replicates `ROADMAP.md` from `StreamBy-UI/` to the workspace root so it is visible across all sub-projects in the monorepo (StreamBy-UI, StreamBy-Package, and any others cloned alongside them).

## When to use

Run `/roadmap` after cloning StreamBy-Package into a local workspace that already has StreamBy-UI cloned as a sibling directory. This ensures the product roadmap is accessible at the workspace root without needing to open the StreamBy-UI repo specifically.

## What this skill does

1. Locates `ROADMAP.md` in `StreamBy-UI/` (sibling of the current repo)
2. Checks whether a `ROADMAP.md` already exists at the workspace root
3. If the workspace root file is older or missing, copies the StreamBy-UI version there
4. Reports what happened to the user

## Steps

Run the following in your terminal from inside `StreamBy-Package/`:

```bash
WORKSPACE_ROOT="$(cd .. && pwd)"
SOURCE="$WORKSPACE_ROOT/StreamBy-UI/ROADMAP.md"
DEST="$WORKSPACE_ROOT/ROADMAP.md"

if [ ! -f "$SOURCE" ]; then
  echo "StreamBy-UI/ROADMAP.md not found. Make sure StreamBy-UI is cloned as a sibling of StreamBy-Package."
  exit 1
fi

if [ -f "$DEST" ]; then
  SOURCE_DATE=$(date -r "$SOURCE" +%s)
  DEST_DATE=$(date -r "$DEST" +%s)
  if [ "$SOURCE_DATE" -le "$DEST_DATE" ]; then
    echo "Workspace ROADMAP.md is already up to date ($(date -r "$DEST" '+%Y-%m-%d %H:%M'))."
    exit 0
  fi
  echo "Updating workspace ROADMAP.md (StreamBy-UI version is newer)..."
else
  echo "No ROADMAP.md found at workspace root. Creating..."
fi

cp "$SOURCE" "$DEST"
echo "ROADMAP.md replicated to: $DEST"
```

After running this, open `ROADMAP.md` at the workspace root to read the full product roadmap for all StreamBy sub-projects.

## Notes

- The source of truth is always `StreamBy-UI/ROADMAP.md` — edit it there and re-run `/roadmap` to propagate changes.
- The workspace root file is not tracked by any repo's git — it is a local convenience copy only.
- If StreamBy-UI is not cloned yet, clone it first: `git clone <streamby-ui-repo-url>` into the same parent directory as StreamBy-Package.
