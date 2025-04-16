#!/bin/bash

# Variables
APP_DIR="/var/www/crowdfund/crowdfund-server"          # Working directory
LOG_FILE="/var/log/crowdfund-server-deploy.log"       # Optional: log script output
PM2_PROCESS_NAME="crowdfund-server"                   # PM2 process name

# Redirect output to log file (optional, remove if not needed)
exec > >(tee -a "$LOG_FILE") 2>&1
echo "Deploy script started at $(date)"

# Ensure we're in the right directory
cd "$APP_DIR" || { echo "Failed to cd into $APP_DIR"; exit 1; }

# Step 1: Pull latest changes from Git
echo "Pulling latest changes..."
git status
git fetch && git pull || { echo "Git pull failed"; exit 1; }

# Install dependencies (needed after git pull in case new packages were added)
echo "Installing dependencies..."
pnpm install || { echo "pnpm install failed"; exit 1; }

# Step 2: Clean the dist folder
echo "Cleaning dist folder..."
pnpm clean || { echo "pnpm clean failed"; exit 1; }

# Step 3: Build the application
echo "Building application..."
pnpm build || { echo "Build failed"; exit 1; }

# Set NODE_ENV explicitly before PM2
export NODE_ENV=production
echo "NODE_ENV set to: $NODE_ENV"

# Step 4: Serve in production with PM2
echo "Checking PM2 process: $PM2_PROCESS_NAME"
if pm2 list | grep -q "$PM2_PROCESS_NAME"; then
  echo "Process $PM2_PROCESS_NAME found, restarting..."
  pm2 restart "$PM2_PROCESS_NAME" --update-env || { echo "Restart failed"; exit 1; }
else
  echo "Process $PM2_PROCESS_NAME not found, starting it..."
  pm2 start "node" --name "$PM2_PROCESS_NAME" \
    --interpreter none \
    -- --require "$APP_DIR/dist/env.js" "$APP_DIR/dist/index.js" \
    --restart-delay 5000 --max-restarts 10 || { echo "PM2 start failed"; exit 1; }
fi

# Save PM2 config to persist across reboots
echo "Saving PM2 configuration..."
pm2 save || { echo "PM2 save failed"; exit 1; }

# Check logs to verify
echo "Verifying server..."
pm2 logs "$PM2_PROCESS_NAME" --lines 10

echo "Deploy script completed at $(date)"