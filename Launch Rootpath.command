#!/bin/zsh
cd "${0:A:h}" || exit 1
if [[ -d release/mac-arm64/Rootpath.app ]]; then
  open release/mac-arm64/Rootpath.app
  exit 0
fi
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  echo "Install Node.js 22.12+ to launch Rootpath."
  read -r "reply?Press Enter to close."
  exit 1
fi
if [ ! -d node_modules ] || [ ! -d dist ]; then
  echo "Run npm install and npm run build in this folder first."
  read -r "reply?Press Enter to close."
  exit 1
fi
npm start
