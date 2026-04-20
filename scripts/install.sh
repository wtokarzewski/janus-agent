#!/usr/bin/env bash
set -euo pipefail

# Janus Agent Installer
# Usage: curl -fsSL https://raw.githubusercontent.com/wtokarzewski/janus-agent/main/scripts/install.sh | bash

REPO="wtokarzewski/janus-agent"
INSTALL_DIR="$HOME/.janus-agent"
BIN_DIR="$HOME/.local/bin"

info()  { printf '\033[34m%s\033[0m\n' "$*"; }
ok()    { printf '\033[32m%s\033[0m\n' "$*"; }
warn()  { printf '\033[33m%s\033[0m\n' "$*"; }
error() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# --- Prerequisites ---

command -v node >/dev/null 2>&1 || error "Node.js is required but not found. Install Node.js 20+ from https://nodejs.org"

NODE_MAJOR=$(node -e "console.log(process.versions.node.split('.')[0])")
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || error "Node.js 20+ is required (found v$(node --version)). Update from https://nodejs.org"

command -v npm >/dev/null 2>&1 || error "npm is required but not found."

if command -v curl >/dev/null 2>&1; then
  FETCH="curl -fsSL"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget -qO-"
else
  error "curl or wget is required but neither was found."
fi

# --- Detect latest release ---

info "Fetching latest release..."
RELEASE_JSON=$($FETCH "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null) || error "Could not reach GitHub API. Check your internet connection."

TAG=$(echo "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | cut -d'"' -f4)
[ -n "$TAG" ] || error "No releases found. The project may not have published a release yet."

TARBALL_URL=$(echo "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.tar\.gz"' | head -1 | cut -d'"' -f4)
[ -n "$TARBALL_URL" ] || error "No tarball asset found in release $TAG."

VERSION="${TAG#v}"
info "Installing Janus v$VERSION..."

# --- Download and extract ---

TMPFILE=$(mktemp /tmp/janus-XXXXXX.tar.gz)
trap 'rm -f "$TMPFILE"' EXIT

$FETCH "$TARBALL_URL" > "$TMPFILE" || error "Download failed."

# Backup existing install
if [ -d "$INSTALL_DIR" ]; then
  warn "Existing installation found. Backing up to ${INSTALL_DIR}.bak"
  rm -rf "${INSTALL_DIR}.bak"
  mv "$INSTALL_DIR" "${INSTALL_DIR}.bak"
fi

mkdir -p "$INSTALL_DIR"
tar xzf "$TMPFILE" --strip-components=1 -C "$INSTALL_DIR" || error "Extraction failed."

# --- Install dependencies ---

info "Installing dependencies..."
cd "$INSTALL_DIR"
npm install --omit=dev --no-audit --no-fund --loglevel=error || error "npm install failed."

# --- Create launcher ---

mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/janus" << 'LAUNCHER'
#!/usr/bin/env bash
exec npx --prefix "$HOME/.janus-agent" tsx "$HOME/.janus-agent/src/index.ts" "$@"
LAUNCHER
chmod +x "$BIN_DIR/janus"

# --- Ensure PATH ---

add_to_path() {
  local rc="$1"
  if [ -f "$rc" ] && ! grep -q '.local/bin' "$rc" 2>/dev/null; then
    echo '' >> "$rc"
    echo '# Janus agent' >> "$rc"
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$rc"
    warn "Added ~/.local/bin to PATH in $rc"
  fi
}

if ! echo "$PATH" | tr ':' '\n' | grep -q '.local/bin'; then
  [ -f "$HOME/.bashrc" ] && add_to_path "$HOME/.bashrc"
  [ -f "$HOME/.zshrc" ] && add_to_path "$HOME/.zshrc"
  export PATH="$BIN_DIR:$PATH"
fi

# --- Done ---

echo ""
ok "Janus v$VERSION installed successfully!"
echo ""
echo "  Location:  $INSTALL_DIR"
echo "  Command:   janus"
echo ""
echo "  Get started:"
echo "    janus onboard    # Initialize workspace"
echo "    janus setup      # Configure LLM provider"
echo "    janus            # Start interactive CLI"
echo ""

if ! command -v janus >/dev/null 2>&1; then
  warn "Note: Restart your shell or run: export PATH=\"\$HOME/.local/bin:\$PATH\""
fi
