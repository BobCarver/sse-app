#!/bin/sh

echo "Starting Deno tests with inspector..."
deno test --inspect-brk=127.0.0.1:9229 --allow-all test/e2e &
DENO_PID=$!

sleep 1

DEBUG_URL=$(curl -s http://127.0.0.1:9229/json | grep -o 'ws://[^"]*')

echo "Deno debugger available at: $DEBUG_URL"

CONFIG_FILE=$(mktemp)
cat > "$CONFIG_FILE" <<EOF
{
  "targets": [
    {
      "name": "deno-tests",
      "webSocketDebuggerUrl": "$DEBUG_URL"
    }
  ]
}
EOF

echo "MCP config written to: $CONFIG_FILE"

echo "Starting Chrome DevTools MCP server..."
chrome-devtools-mcp --config "$CONFIG_FILE" &
MCP_PID=$!

echo "Waiting for VS Code to attach..."
echo "Open VS Code → Run and Debug → 'Debug Deno Tests + MCP'"

cleanup() {
  echo "Shutting down MCP server and Deno..."
  kill $MCP_PID 2>/dev/null
  kill $DENO_PID 2>/dev/null
  rm "$CONFIG_FILE"
}
trap cleanup EXIT

wait
