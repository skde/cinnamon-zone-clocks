#!/usr/bin/env bash
# Installs the Zone Clocks applet for the current user.
#
#   ./install.sh            copy the applet into ~/.local/share/cinnamon/applets
#   ./install.sh --link     symlink it instead (handy while developing)
#   ./install.sh --enable   also add it to the right side of the main panel
#
# Flags can be combined. Re-running the script updates an existing install
# and asks Cinnamon to reload the applet.
set -euo pipefail

UUID="zoneclocks@skde"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$UUID"
DEST="$HOME/.local/share/cinnamon/applets/$UUID"
MODE="copy"
ENABLE="no"

for arg in "$@"; do
    case "$arg" in
        --link) MODE="link" ;;
        --enable) ENABLE="yes" ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 1 ;;
    esac
done

[[ -f "$SRC/applet.js" ]] || { echo "Cannot find $SRC/applet.js" >&2; exit 1; }

mkdir -p "$(dirname "$DEST")"
if [[ -L "$DEST" || -d "$DEST" ]]; then
    rm -rf "$DEST"
fi
if [[ "$MODE" == "link" ]]; then
    ln -s "$SRC" "$DEST"
    echo "Linked   $DEST -> $SRC"
else
    cp -r "$SRC" "$DEST"
    echo "Copied   $SRC -> $DEST"
fi

if [[ "$ENABLE" == "yes" ]]; then
    python3 - "$UUID" <<'PY'
import ast, subprocess, sys
uuid = sys.argv[1]
raw = subprocess.check_output(["gsettings", "get", "org.cinnamon", "enabled-applets"], text=True).strip()
applets = ast.literal_eval(raw) if raw.startswith("[") else []
if any(f":{uuid}:" in a for a in applets):
    print("Already on the panel.")
    sys.exit(0)
ids = [int(a.split(":")[4]) for a in applets if a.count(":") == 4 and a.split(":")[4].isdigit()]
new_id = max(ids, default=0) + 1
panel = applets[0].split(":")[0] if applets else "panel1"
applets.append(f"{panel}:right:0:{uuid}:{new_id}")
value = "[" + ", ".join("'" + a + "'" for a in applets) + "]"
subprocess.check_call(["gsettings", "set", "org.cinnamon", "enabled-applets", value])
print(f"Added to {panel} (instance {new_id}).")
PY
fi

# Reload if Cinnamon already has the applet loaded (no-op otherwise).
if command -v dbus-send >/dev/null 2>&1; then
    dbus-send --session --dest=org.Cinnamon --type=method_call /org/Cinnamon \
        org.Cinnamon.ReloadXlet string:"$UUID" string:"APPLET" 2>/dev/null || true
fi

cat <<MSG

Done. To add the clocks to a panel:
  right-click the panel -> Applets -> "Zone Clocks" -> + (add to panel)
Then right-click the applet -> Configure... to add, edit, remove or color clocks.
MSG
