#!/bin/bash

# Script to start Deno test debugger and chrome-devtools-mcp server
# Usage: ./start-debug-session.sh

set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}Starting Deno Test Debugger Session...${NC}"

# Temporary file to capture Deno output
DENO_LOG=$(mktemp)

# Function to cleanup background processes and temp files on exit
cleanup() {
    echo -e "\n${YELLOW}Shutting down processes...${NC}"
    kill $(jobs -p) 2>/dev/null || true
    rm -f "$DENO_LOG"
    exit
}

trap cleanup SIGINT SIGTERM EXIT

# Start Deno test with debugger, capturing output
echo -e "${GREEN}Starting Deno tests with --inspect-brk --watch...${NC}"
deno test --inspect-brk --watch --allow-env test 2>&1 | tee "$DENO_LOG" &
DENO_PID=$!

# Wait for debugger to start and extract WebSocket URL
echo -e "${YELLOW}Waiting for debugger WebSocket URL...${NC}"
DEBUGGER_URL=""
# Increase timeout to give Deno more time to start inspector on slower machines
TIMEOUT=30
ELAPSED=0

while [ -z "$DEBUGGER_URL" ] && [ $ELAPSED -lt $TIMEOUT ]; do
    # Try to extract WebSocket URL from Deno output
    # Show last few lines to help debugging when detection fails
    echo -e "${YELLOW}--- Deno log tail (for debugging) ---${NC}"
    tail -n 20 "$DENO_LOG" || true

    # Use a slightly more permissive regex and allow for CR/ANSI noise
    DEBUGGER_URL=$(grep -o 'ws://[^"\'\'[:space:]]*' "$DENO_LOG" 2>/dev/null | head -1 || true)

    if [ -z "$DEBUGGER_URL" ]; then
        sleep 0.5
        ELAPSED=$((ELAPSED + 1))
    fi
done

# Check if we found the debugger URL
if [ -z "$DEBUGGER_URL" ]; then
    echo -e "${RED}✗ Failed to detect debugger WebSocket URL after ${TIMEOUT}s${NC}"
    echo -e "${YELLOW}Make sure Deno is starting correctly with --inspect-brk${NC}"
    exit 1
fi

echo -e "${GREEN}✓ Found debugger at: ${DEBUGGER_URL}${NC}"

# Start chrome-devtools-mcp server with the debugger URL
echo -e "${GREEN}Starting chrome-devtools-mcp server...${NC}"
npx @modelcontextprotocol/server-chrome-devtools "$DEBUGGER_URL" &
MCP_PID=$!

# Give MCP server a moment to connect
sleep 1

echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}✓ Both processes running!${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "Deno PID:        ${DENO_PID}"
echo -e "MCP PID:         ${MCP_PID}"
echo -e "Debugger URL:    ${DEBUGGER_URL}"
echo -e "\nPress ${YELLOW}Ctrl+C${NC} to stop both processes"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}\n"

# Continue tailing Deno output
tail -f "$DENO_LOG" &
TAIL_PID=$!

# Wait for processes (this blocks until interrupted)
wait $DENO_PID $MCP_PID 2>/dev/null || true