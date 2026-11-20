#!/bin/zsh
# Double-click (or add to Login Items) to start Alfred's interface and open it in your browser.
# The server keeps running in the background even after this window closes.
# To stop it: pkill -f alfred_server.pl
cd "$(dirname "$0")"
mkdir -p ~/Library/Logs/Alfred
if ! curl -s -o /dev/null --max-time 1 http://localhost:8765/api/state; then
  nohup perl app/alfred_server.pl >> ~/Library/Logs/Alfred/server.log 2>&1 &
  disown
  sleep 1
fi
open http://localhost:8765
exit 0
