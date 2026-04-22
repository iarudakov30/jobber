#!/bin/sh
set -e

echo "Starting application..."
exec node /app/dist/apps/executor/main
